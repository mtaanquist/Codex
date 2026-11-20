// The Assistant's cached work (character arcs, enrich reads, scene and chapter
// summaries) is refreshed only when it is marked out of date, and every write
// path marks by hand. This test applies seeded random sequences of writer
// actions through the real server functions and, after each one, checks the
// marks against what the Assistant would actually be sent:
//
// - anything whose input changed must be marked (a missed mark leaves the
//   writer with an arc or summary describing text that is no longer there);
//   for an enrich read, only a passage it has not read yet counts, since a
//   trash or mute that only takes passages away is not worth a paid re-read;
// - a scene or chapter summary whose input did not change must not be marked
//   (summaries have no fingerprint check, so a needless mark is a paid call).
//
// Arcs and enrich reads carry a fingerprint of their last request and skip the
// call when it matches, so a needless mark there costs no model call; those are
// printed, not failed.
//
// The marks the passes themselves set (a new scene summary marks its chapter
// and the arcs that read it) are checked again after each round of passes.
//
// A failure prints the seed and the actions that led to it. STALE_SEEDS and
// STALE_STEPS widen a local run.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, isNull, isNotNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	chapters,
	characters,
	loreEntries,
	places,
	revisions,
	scenes,
	stories,
	storyDrafts,
	universes,
	users
} from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import type { GatewayDeps } from '../../src/lib/server/llm/gateway';
import type { HttpRequest, Provider } from '../../src/lib/server/llm/providers/types';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';
import {
	createChapter,
	createScene,
	deleteChapter,
	moveChapter,
	renameChapter,
	restoreScene,
	STALE_MARK_BEFORE,
	trashScene
} from '../../src/lib/server/scene-lifecycle';
import { duplicateScene, mergeScenes, splitScene } from '../../src/lib/server/scene-split-merge';
import { applySceneOrder, type SceneOrder } from '../../src/lib/server/scene-order';
import { saveSceneBody } from '../../src/lib/server/scene-save';
import { setSceneStatus } from '../../src/lib/server/scene-status';
import { restoreStory, trashStory } from '../../src/lib/server/story-lifecycle';
import { saveStoryDetails } from '../../src/lib/server/story-details';
import { saveEntity, type EntitySaveKind } from '../../src/lib/server/entity-save';
import {
	markUniverseMentionsChanged,
	rebuildUniverseMentions,
	reconcileMentions
} from '../../src/lib/server/mentions';
import { summaryIsCurrent } from '../../src/lib/server/summary-currency';
import {
	buildChapterSummaryMessage,
	buildSceneSummaryMessage
} from '../../src/lib/server/llm/prompts/summary';
import { SCENE_STATUSES } from '../../src/lib/scene-status';
import { replaceProse } from '../../src/lib/server/prose-replace';
import { restoreRevision } from '../../src/lib/server/revisions';
import { createSuggestion, decideSuggestion } from '../../src/lib/server/review';
import { newStoryFromDraft, restoreDraftScene, saveDraft } from '../../src/lib/server/story-drafts';
import { createStoryEntity } from '../../src/lib/server/create-entity';
import { clearMentionPin, setMentionPin } from '../../src/lib/server/mention-pins';
import {
	decideEntitySuggestion,
	stageEntitySuggestions
} from '../../src/lib/server/entity-suggestions';

// Storing the account API key encrypts it with APP_SECRET.
process.env.APP_SECRET = process.env.APP_SECRET || 'stale-marks-invariant-secret';

const { arcIsStale, arcRequest, summariseCharacterArc } =
	await import('../../src/lib/server/llm/arc-summary');
const { enrichRequest, enrichUniverse, MAX_APPEARANCES } =
	await import('../../src/lib/server/llm/enrich');
const { entityAppearances } = await import('../../src/lib/server/plan-data');
const { summariseStory } = await import('../../src/lib/server/llm/summaries');
const { saveAccountLlmConfig, saveStoryLlmOverride } =
	await import('../../src/lib/server/llm/config');

let chapterCount = 0;
let draftCount = 0;

const SEEDS = Number(process.env.STALE_SEEDS ?? 8);
const STEPS = Number(process.env.STALE_STEPS ?? 30);

const hash = (text: string) => createHash('sha256').update(text).digest('hex');

// Replies with text that follows the prompt, so a summary written from a
// different input reads differently (and moves what reads it). Not JSON, so
// an enrich read stages nothing.
const stubProvider: Provider = {
	async *chatStream() {
		yield { type: 'done' };
	},
	async respond(req) {
		const prompt = req.messages.map((m) => String(m.content)).join('\n');
		const content = `Summary ${hash(JSON.stringify(req.messages)).slice(0, 8)}.`;
		writtenFrom.set(content, prompt.slice(prompt.indexOf('Summarise ')));
		return {
			content,
			toolCalls: [],
			usage: { promptTokens: 10, completionTokens: 10 }
		};
	},
	async listModels() {
		return [];
	}
};
const noHttp: HttpRequest = async () => {
	throw new Error('the injected provider should not call the transport');
};
const deps: GatewayDeps = { provider: stubProvider, http: noHttp };

// mulberry32: small, seedable, good enough to pick actions.
function rng(seed: number) {
	let a = seed >>> 0;
	const next = () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	return {
		int: (n: number) => Math.floor(next() * n),
		pick<T>(items: readonly T[]): T | undefined {
			return items.length ? items[Math.floor(next() * items.length)] : undefined;
		},
		chance: (p: number) => next() < p
	};
}
type Rng = ReturnType<typeof rng>;

const NAMES = ['Bram', 'Corin', 'Isolde', 'Aldermoor', 'Saltmarsh', 'the Tidecall'];
const VERBS = ['waits by', 'argues about', 'remembers', 'walks past', 'dreams of', 'avoids'];
const WEATHER = ['in the rain', 'at dawn', 'after supper', 'without a word', 'once more'];

function sentence(r: Rng): string {
	const who = r.pick(NAMES)!;
	const what = r.pick(NAMES)!;
	return `${who} ${r.pick(VERBS)} ${what} ${r.pick(WEATHER)}.`;
}

function paragraph(r: Rng): string {
	return Array.from({ length: 1 + r.int(2) }, () => sentence(r)).join(' ');
}

let pool: pg.Pool;
let db: Database;
let userId: string;
let universeId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

afterAll(async () => {
	await pool.end();
});

async function seedWorld(r: Rng) {
	await pool.query(
		'truncate table assistant_job_spend, entity_mentions, entity_suggestions, revisions, scenes, chapters, characters, places, lore_entries, stories, universes, users cascade'
	);
	const [user] = await db
		.insert(users)
		.values({ email: 'w@example.com', displayName: 'W', passwordHash: 'x', role: 'user' })
		.returning({ id: users.id });
	userId = user.id;
	const [universe] = await db
		.insert(universes)
		.values({ ownerId: userId, name: 'Aldermoor' })
		.returning({ id: universes.id });
	universeId = universe.id;
	await saveAccountLlmConfig(db, userId, {
		enabled: true,
		assistantName: '',
		persona: 'balanced',
		endpoint: 'https://api.example.com/v1',
		apiKey: 'sk',
		models: { chat: 'chat-model' },
		toolCallBudget: 8
	});
	await db.insert(characters).values([
		{ universeId, ownerId: userId, name: 'Bram', aliases: ['the captain'] },
		{ universeId, ownerId: userId, name: 'Corin' },
		{ universeId, ownerId: userId, name: 'Isolde' }
	]);
	await db.insert(places).values([
		{ universeId, ownerId: userId, name: 'Aldermoor' },
		{ universeId, ownerId: userId, name: 'Saltmarsh' }
	]);
	const [category] = await db
		.insert(schema.entityCategories)
		.values({ universeId, ownerId: userId, name: 'Myth', sortOrder: 0 })
		.returning({ id: schema.entityCategories.id });
	await db.insert(loreEntries).values({
		universeId,
		ownerId: userId,
		title: 'the Tidecall',
		keywords: [],
		categoryId: category.id
	} as typeof loreEntries.$inferInsert);

	for (const [index, title] of ['The Tide Below', 'The Salt Road'].entries()) {
		const [story] = await db
			.insert(stories)
			.values({ universeId, ownerId: userId, title, positionInSeries: index + 1 })
			.returning({ id: stories.id });
		for (let c = 0; c < 2; c++) {
			const chapterId = (await createChapter(db, userId, story.id))!;
			for (let s = 0; s < 2; s++) {
				const sceneId = (await createScene(db, userId, story.id, chapterId))!;
				await save(sceneId, `Scene ${c + 1}.${s + 1}`, [paragraph(r), paragraph(r)].join('\n\n'));
			}
		}
	}
}

async function save(sceneId: string, title: string | null, bodyMd: string) {
	const result = await saveSceneBody(db, sceneId, {
		title,
		bodyMd,
		anchors: null,
		baseHashes: null,
		overwrite: false
	});
	expect(result.ok, 'scene save').toBe(true);
}

// What the background workers would do on their own: index mentions.
async function settleMentions() {
	while ((await reconcileMentions(db)) > 0);
}

// ---------------------------------------------------------------------------
// Reading state

async function liveStories() {
	return db
		.select({ id: stories.id, title: stories.title, slug: stories.slug })
		.from(stories)
		.where(and(eq(stories.universeId, universeId), isNull(stories.deletedAt)))
		.orderBy(asc(stories.positionInSeries));
}

async function trashedStories() {
	return db
		.select({ id: stories.id })
		.from(stories)
		.where(and(eq(stories.universeId, universeId), isNotNull(stories.deletedAt)));
}

async function storyMuted(storyId: string): Promise<boolean> {
	const [row] = await db
		.select({ muted: sql<boolean>`(${stories.llmConfig} ->> 'enabled') = 'false'` })
		.from(stories)
		.where(eq(stories.id, storyId));
	return !!row?.muted;
}

async function liveScenes(storyId?: string) {
	return db
		.select({
			id: scenes.id,
			storyId: scenes.storyId,
			chapterId: scenes.chapterId,
			title: scenes.title,
			bodyMd: scenes.bodyMd
		})
		.from(scenes)
		.innerJoin(stories, eq(stories.id, scenes.storyId))
		.where(
			and(
				eq(stories.universeId, universeId),
				isNull(stories.deletedAt),
				isNull(scenes.deletedAt),
				storyId ? eq(scenes.storyId, storyId) : undefined
			)
		)
		.orderBy(asc(stories.positionInSeries), asc(scenes.globalPosition));
}

async function storyOrder(storyId: string): Promise<SceneOrder> {
	const chapterRows = await db
		.select({ id: chapters.id })
		.from(chapters)
		.where(eq(chapters.storyId, storyId))
		.orderBy(asc(chapters.position));
	const sceneRows = await liveScenes(storyId);
	return {
		chapters: chapterRows.map((c) => ({
			id: c.id,
			sceneIds: sceneRows.filter((s) => s.chapterId === c.id).map((s) => s.id)
		})),
		orphanSceneIds: sceneRows.filter((s) => !s.chapterId).map((s) => s.id)
	};
}

// ---------------------------------------------------------------------------
// Writer actions. Each returns a description for the failure log, or null
// when it does not apply to the current state.

type Action = (r: Rng) => Promise<string | null>;

async function someScene(r: Rng) {
	return r.pick(await liveScenes());
}

const actions: Record<string, Action> = {
	async editParagraph(r) {
		const scene = await someScene(r);
		if (!scene) return null;
		const paras = scene.bodyMd.split('\n\n');
		paras[r.int(paras.length)] = paragraph(r);
		await save(scene.id, scene.title, paras.join('\n\n'));
		return `edit a paragraph of ${scene.title}`;
	},
	async addParagraph(r) {
		const scene = await someScene(r);
		if (!scene) return null;
		await save(scene.id, scene.title, `${scene.bodyMd}\n\n${paragraph(r)}`);
		return `add a paragraph to ${scene.title}`;
	},
	async swapParagraphs(r) {
		const scene = await someScene(r);
		const paras = scene?.bodyMd.split('\n\n') ?? [];
		if (!scene || paras.length < 2) return null;
		const i = r.int(paras.length - 1);
		[paras[i], paras[i + 1]] = [paras[i + 1], paras[i]];
		await save(scene.id, scene.title, paras.join('\n\n'));
		return `swap paragraphs ${i + 1} and ${i + 2} of ${scene.title}`;
	},
	async renameScene(r) {
		const scene = await someScene(r);
		if (!scene) return null;
		const title = `${scene.title ?? 'Scene'} ${r.int(100)}`;
		await save(scene.id, title, scene.bodyMd);
		return `rename ${scene.title} to ${title}`;
	},
	async sceneStatus(r) {
		const scene = await someScene(r);
		const status = r.pick(SCENE_STATUSES)!;
		if (!scene) return null;
		await setSceneStatus(db, userId, scene.id, status);
		return `set ${scene.title} to ${status}`;
	},
	async moveScene(r) {
		const story = r.pick(await liveStories());
		if (!story) return null;
		const order = await storyOrder(story.id);
		const all = order.chapters.flatMap((c) => c.sceneIds);
		const moving = r.pick(all);
		if (!moving || !order.chapters.length) return null;
		for (const c of order.chapters) c.sceneIds = c.sceneIds.filter((id) => id !== moving);
		const target = r.pick(order.chapters)!;
		target.sceneIds.splice(r.int(target.sceneIds.length + 1), 0, moving);
		const result = await applySceneOrder(db, story.id, order);
		expect(result.ok, 'scene order').toBe(true);
		return `move a scene in ${story.title}`;
	},
	async trashScene(r) {
		const scene = await someScene(r);
		if (!scene) return null;
		await trashScene(db, userId, scene.id);
		return `trash ${scene.title}`;
	},
	async restoreScene(r) {
		const trashed = await db
			.select({ id: scenes.id, title: scenes.title })
			.from(scenes)
			.innerJoin(stories, eq(stories.id, scenes.storyId))
			.where(
				and(
					eq(stories.universeId, universeId),
					isNull(stories.deletedAt),
					isNotNull(scenes.deletedAt)
				)
			)
			.orderBy(asc(stories.positionInSeries), asc(scenes.globalPosition), asc(scenes.deletedAt));
		const scene = r.pick(trashed);
		if (!scene) return null;
		await restoreScene(db, userId, scene.id);
		return `restore ${scene.title}`;
	},
	async splitScene(r) {
		const scene = await someScene(r);
		const at = scene?.bodyMd.indexOf('\n\n') ?? -1;
		if (!scene || at < 0) return null;
		const result = await splitScene(db, userId, scene.id, at + 2);
		if (!result.ok) return null;
		return `split ${scene.title}`;
	},
	async mergeScenes(r) {
		const story = r.pick(await liveStories());
		if (!story) return null;
		const order = await storyOrder(story.id);
		const chapter = r.pick(order.chapters.filter((c) => c.sceneIds.length >= 2));
		if (!chapter) return null;
		const i = r.int(chapter.sceneIds.length - 1);
		const result = await mergeScenes(db, userId, story.id, chapter.sceneIds.slice(i, i + 2));
		if (!result.ok) return null;
		return `merge two scenes in ${story.title}`;
	},
	async duplicateScene(r) {
		const scene = await someScene(r);
		if (!scene) return null;
		const result = await duplicateScene(db, userId, scene.id);
		if (!result.ok) return null;
		return `duplicate ${scene.title}`;
	},
	async newScene(r) {
		const story = r.pick(await liveStories());
		if (!story) return null;
		const order = await storyOrder(story.id);
		const chapterId = r.pick(order.chapters)?.id ?? null;
		const sceneId = await createScene(db, userId, story.id, chapterId);
		if (!sceneId) return null;
		await save(sceneId, `New ${r.int(100)}`, paragraph(r));
		return `write a new scene in ${story.title}`;
	},
	async renameStory(r) {
		const story = r.pick(await liveStories());
		if (!story) return null;
		const title = `${story.title.split(' (')[0]} (${r.int(100)})`;
		await saveStoryDetails(db, userId, story, {
			title,
			author: null,
			brief: null,
			descriptionMd: null,
			styleNotes: null,
			coverColor: null
		});
		return `rename story ${story.title} to ${title}`;
	},
	async muteStory(r) {
		const story = r.pick(await liveStories());
		if (!story) return null;
		const muted = await storyMuted(story.id);
		await saveStoryLlmOverride(db, story.id, { enabled: muted ? null : false });
		return `${muted ? 'unmute' : 'mute'} ${story.title}`;
	},
	async trashStory(r) {
		const live = await liveStories();
		// Keep one story live so most steps have something to act on.
		if (live.length < 2) return null;
		const story = r.pick(live)!;
		await trashStory(db, userId, story.id);
		return `trash story ${story.title}`;
	},
	async restoreStory(r) {
		const story = r.pick(await trashedStories());
		if (!story) return null;
		await restoreStory(db, userId, story.id);
		return `restore a story`;
	},
	async renameChapter(r) {
		const story = r.pick(await liveStories());
		const chapter = story && r.pick((await storyOrder(story.id)).chapters);
		if (!chapter) return null;
		await renameChapter(db, userId, chapter.id, `Chapter ${++chapterCount}`);
		return `rename a chapter in ${story.title}`;
	},
	async moveChapter(r) {
		const story = r.pick(await liveStories());
		const chapter = story && r.pick((await storyOrder(story.id)).chapters);
		if (!chapter) return null;
		const direction = r.chance(0.5) ? 'up' : 'down';
		await moveChapter(db, userId, chapter.id, direction);
		return `move a chapter ${direction} in ${story.title}`;
	},
	async deleteChapter(r) {
		const story = r.pick(await liveStories());
		const order = story ? await storyOrder(story.id) : null;
		if (!story || !order || order.chapters.length < 2) return null;
		await deleteChapter(db, userId, r.pick(order.chapters)!.id);
		return `delete a chapter in ${story.title}`;
	},
	async editEntity(r) {
		const kind = r.pick(['character', 'place', 'lore'] as const)!;
		const table = kind === 'character' ? characters : kind === 'place' ? places : loreEntries;
		const rows = await db
			.select({ id: table.id })
			.from(table)
			.where(eq(table.universeId, universeId))
			// Seeded together, so by name for a repeatable pick.
			.orderBy(
				asc(kind === 'lore' ? loreEntries.title : table === places ? places.name : characters.name)
			);
		const target = r.pick(rows);
		if (!target) return null;
		const current = await loadEntity(kind, target.id);
		const change = r.pick(['name', 'tags', 'details', 'summary', 'body'] as const)!;
		const next = { ...current };
		if (change === 'name') {
			next.name = `${current.name.split(' ')[0]} ${r.int(100)}`;
			// Kept as an alias, the old name still finds the same passages, so
			// only the rename itself can mark what reads the name.
			if (r.chance(0.5) && !next.tags.includes(current.name))
				next.tags = [...next.tags, current.name];
		}
		if (change === 'tags') {
			// "the rain" and "at dawn" are in the prose, so the alias finds new
			// passages; the others find none.
			next.tags = r.chance(0.3)
				? []
				: [r.pick(['the rain', 'at dawn', 'the old one', 'the stranger'])!];
		}
		if (change === 'details') next.details = [{ label: 'Age', value: String(20 + r.int(40)) }];
		if (change === 'summary') next.summaryMd = `Summary ${r.int(1000)}`;
		if (change === 'body') next.bodyMd = `Notes ${r.int(1000)}`;
		const result = await saveEntity(db, kind as EntitySaveKind, target.id, userId, next);
		expect(result.ok, 'entity save').toBe(true);
		// As the autosave endpoint does when names or tags change.
		if (result.ok && result.mentionsAffected) {
			await markUniverseMentionsChanged(db, universeId);
			await rebuildUniverseMentions(db, universeId);
		}
		return `change the ${change} of ${kind} ${current.name}`;
	}
};

// What the routes do after a change that can add or remove mentions anywhere.
async function reindexUniverse() {
	await markUniverseMentionsChanged(db, universeId);
	await rebuildUniverseMentions(db, universeId);
}

// Words the prose already holds, for changes that swap one for another.
const SWAPS = [...NAMES.slice(0, 3), ...WEATHER];

// Every entity of the universe, in a repeatable order.
async function allEntities() {
	const out: { kind: 'character' | 'place' | 'lore'; id: string; name: string }[] = [];
	for (const entity of await entityStates())
		out.push({ kind: entity.kind, id: entity.id, name: entity.name });
	return out;
}
const REVISION_TYPE = { character: 'character', place: 'place', lore: 'lore_entry' } as const;

async function someDraft(r: Rng) {
	const live = await liveStories();
	if (!live.length) return null;
	const rows = await db
		.select({ id: storyDrafts.id, storyId: storyDrafts.storyId, label: storyDrafts.label })
		.from(storyDrafts)
		.where(
			inArray(
				storyDrafts.storyId,
				live.map((story) => story.id)
			)
		)
		.orderBy(asc(storyDrafts.label));
	return r.pick(rows) ?? null;
}

const RARE = [
	'restoreScene',
	'restoreStory',
	'muteStory',
	'pinMention',
	'restoreEntityRevision',
	'restoreDraftScene',
	'storyFromDraft',
	'saveDraft',
	'createEntityFromStory',
	'pinMention',
	'editEntity'
];

// The write paths outside the editor's own save (#1214).
const moreActions: Record<string, Action> = {
	async findAndReplace(r) {
		const find = r.pick(SWAPS)!;
		const replace = r.pick(SWAPS.filter((word) => word !== find))!;
		const result = await replaceProse(db, universeId, find, replace);
		if (result.occurrences === 0) return null;
		return `replace "${find}" with "${replace}" everywhere`;
	},
	async restoreSceneRevision(r) {
		const rows = await db
			.select({ id: revisions.id, sceneId: scenes.id, title: scenes.title })
			.from(revisions)
			.innerJoin(scenes, eq(scenes.id, revisions.entityId))
			.innerJoin(stories, eq(stories.id, scenes.storyId))
			.where(
				and(
					eq(revisions.entityType, 'scene'),
					eq(stories.universeId, universeId),
					isNull(stories.deletedAt),
					isNull(scenes.deletedAt)
				)
			)
			.orderBy(asc(revisions.createdAt), asc(scenes.globalPosition));
		const revision = r.pick(rows);
		if (!revision) return null;
		const result = await restoreRevision(db, userId, revision.id, 'scene', revision.sceneId);
		expect(result.ok, 'scene restore').toBe(true);
		return `restore an earlier version of ${revision.title}`;
	},
	async restoreEntityRevision(r) {
		const entities = await allEntities();
		// Only an entity that has been saved has a version to go back to.
		const rows = entities.length
			? await db
					.select({ id: revisions.id, entityId: revisions.entityId })
					.from(revisions)
					.where(
						and(
							inArray(revisions.entityType, Object.values(REVISION_TYPE)),
							inArray(
								revisions.entityId,
								entities.map((entity) => entity.id)
							)
						)
					)
					.orderBy(asc(revisions.createdAt))
			: [];
		const revision = r.pick(rows);
		const entity = entities.find((candidate) => candidate.id === revision?.entityId);
		if (!revision || !entity) return null;
		const type = REVISION_TYPE[entity.kind];
		const result = await restoreRevision(db, userId, revision.id, type, entity.id);
		expect(result.ok, 'entity restore').toBe(true);
		if (result.ok && result.mentionsAffected) await reindexUniverse();
		return `restore an earlier version of ${entity.kind} ${entity.name}`;
	},
	async acceptSuggestion(r) {
		const scene = await someScene(r);
		// A word this scene holds, so the step is not lost to a miss.
		const word = scene && r.pick(SWAPS.filter((swap) => scene.bodyMd.includes(swap)));
		if (!scene || !word) return null;
		const start = scene.bodyMd.indexOf(word);
		const replacement = r.pick(SWAPS.filter((other) => other !== word))!;
		const created = await createSuggestion(db, {
			storyId: scene.storyId,
			sceneId: scene.id,
			author: { userId },
			range: { start, end: start + word.length },
			replacement
		});
		if (!created.ok) return null;
		const result = await decideSuggestion(db, userId, scene.storyId, created.suggestionId, true);
		expect(result.ok, 'accept suggestion').toBe(true);
		return `accept a suggestion on ${scene.title}: "${word}" to "${replacement}"`;
	},
	async saveDraft(r) {
		const story = r.pick(await liveStories());
		if (!story) return null;
		const result = await saveDraft(db, userId, story.id, {
			label: `Draft ${String(++draftCount).padStart(3, '0')}`,
			note: ''
		});
		expect(result.ok, 'save draft').toBe(true);
		return `save a draft of ${story.title}`;
	},
	async restoreDraftScene(r) {
		const draft = await someDraft(r);
		if (!draft) return null;
		const [row] = await db
			.select({ content: storyDrafts.content })
			.from(storyDrafts)
			.where(eq(storyDrafts.id, draft.id));
		const saved = r.pick(row.content.scenes);
		if (!saved) return null;
		const result = await restoreDraftScene(db, draft.storyId, draft.id, saved.id);
		if (!result.ok) return null;
		return `restore a scene from ${draft.label}${result.created ? ' (added back)' : ''}`;
	},
	async storyFromDraft(r) {
		const draft = await someDraft(r);
		// A few stories are enough; each one makes every later step slower.
		if (!draft || (await liveStories()).length >= 4) return null;
		const [story] = await db.select().from(stories).where(eq(stories.id, draft.storyId));
		const result = await newStoryFromDraft(db, userId, story, draft.id, '');
		if (!result.ok) return null;
		await reindexUniverse();
		return `start a new story from ${draft.label}`;
	},
	async createEntityFromStory(r) {
		const story = r.pick(await liveStories());
		// Words the prose holds, so the new entry is mentioned at once. A name
		// taken twice makes it ambiguous, which is what a pin settles.
		const name = r.pick(['Corin', 'Isolde', 'Bram', 'the rain'])!;
		const existing = (await allEntities()).filter((entity) => entity.name === name);
		if (!story || existing.length >= 2) return null;
		const type = r.pick(['character', 'place'] as const)!;
		const result = await createStoryEntity(
			db,
			{ universeId, ownerId: userId, storyId: story.id },
			type,
			name
		);
		if (!result.ok) return null;
		await reindexUniverse();
		return `create ${type} "${name}" from ${story.title}`;
	},
	async pinMention(r) {
		const story = r.pick(await liveStories());
		const entities = await allEntities();
		const shared = entities.filter(
			(entity) => entities.filter((other) => other.name === entity.name).length > 1
		);
		const target = r.pick(shared);
		if (!story || !target) return null;
		if (r.chance(0.3)) {
			if (!(await clearMentionPin(db, userId, story.id, target.name))) return null;
			await reindexUniverse();
			return `clear the pin on "${target.name}" in ${story.title}`;
		}
		const result = await setMentionPin(
			db,
			userId,
			story.id,
			target.name,
			target.kind === 'lore' ? 'lore_entry' : target.kind,
			target.id
		);
		expect(result.ok, 'pin').toBe(true);
		await reindexUniverse();
		return `pin "${target.name}" in ${story.title} to a ${target.kind}`;
	},
	async acceptAliasSuggestion(r) {
		const entity = r.pick(await allEntities());
		if (!entity) return null;
		const alias = r.pick(['the rain', 'at dawn', 'supper', 'a word'])!;
		const [staged] = await stageEntitySuggestions(db, {
			ownerId: userId,
			kind: entity.kind,
			entityId: entity.id,
			proposals: [{ field: 'alias', value: alias }]
		});
		if (!staged) return null;
		const result = await decideEntitySuggestion(db, userId, staged.id, 'accept');
		expect(result.ok, 'accept alias').toBe(true);
		if (result.ok && result.reindexUniverseId) await reindexUniverse();
		return `accept the alias "${alias}" for ${entity.kind} ${entity.name}`;
	}
};
Object.assign(actions, moreActions);

async function loadEntity(kind: 'character' | 'place' | 'lore', id: string) {
	if (kind === 'lore') {
		const [row] = await db.select().from(loreEntries).where(eq(loreEntries.id, id));
		return {
			name: row.title,
			tags: row.keywords ?? [],
			summaryMd: row.summaryMd,
			bodyMd: row.bodyMd ?? '',
			details: row.details ?? []
		};
	}
	const table = kind === 'character' ? characters : places;
	const [row] = await db.select().from(table).where(eq(table.id, id));
	return {
		name: row.name,
		tags: row.aliases ?? [],
		summaryMd: row.summaryMd,
		bodyMd: row.bodyMd ?? '',
		details: row.details ?? []
	};
}

// ---------------------------------------------------------------------------
// The Assistant's side: bring everything current, then check marks against
// what it would be sent.

// Summaries store no fingerprint of their own, so the stub keeps the prompt
// each reply was written from, keyed by the reply. A copied summary (split,
// duplicate) carries its source's text, so it maps to its source's prompt.
const writtenFrom = new Map<string, string>();

// Summaries whose input differed from what they were written from at some step
// since, even if a later step put it back (a swap undone): their mark is owed.
// Keyed by id and summary text, so a new summary starts clean.
const dirty = new Set<string>();

// The scenes, in order, each chapter held when its summary was written, keyed
// as `dirty` is.
const chapterScenes = new Map<string, string>();

const label = (title: string | null, id: string) => title ?? `untitled ${id.slice(0, 4)}`;

// The prose a scene summary prompt carries, after its "---" line.
const promptBody = (prompt: string) => prompt.slice(prompt.indexOf('\n---\n') + 5);
const promptTitle = (prompt: string) => prompt.slice(0, prompt.indexOf('\n'));
const uncopied = (title: string) => title.replaceAll(' (copy)', '');

async function chapterStates() {
	const rows = await db
		.select({
			id: chapters.id,
			storyId: chapters.storyId,
			title: chapters.title,
			summaryMd: chapters.summaryMd,
			summaryGeneratedAt: chapters.summaryGeneratedAt,
			updatedAt: chapters.updatedAt
		})
		.from(chapters)
		.innerJoin(stories, eq(stories.id, chapters.storyId))
		.where(and(eq(stories.universeId, universeId), isNull(stories.deletedAt)))
		.orderBy(asc(stories.positionInSeries), asc(chapters.position));
	const out = [];
	for (const chapter of rows) {
		const sceneRows = await db
			.select({ id: scenes.id, summaryMd: scenes.summaryMd })
			.from(scenes)
			.where(and(eq(scenes.chapterId, chapter.id), isNull(scenes.deletedAt)))
			.orderBy(asc(scenes.globalPosition));
		const summaries = sceneRows.map((s) => s.summaryMd?.trim()).filter((s): s is string => !!s);
		out.push({
			id: chapter.id,
			name: `chapter summary of ${label(chapter.title, chapter.id)}`,
			summaryMd: chapter.summaryMd,
			sceneIds: sceneRows.map((s) => s.id).join(),
			// A chapter with no scene summaries is passed over, not refreshed.
			input: summaries.length ? buildChapterSummaryMessage(chapter.title, summaries) : null,
			generated: chapter.summaryGeneratedAt !== null,
			stale: !summaryIsCurrent(chapter.summaryGeneratedAt, chapter.updatedAt)
		});
	}
	return out;
}

async function sceneStates() {
	const rows = await db
		.select({
			id: scenes.id,
			chapterId: scenes.chapterId,
			title: scenes.title,
			bodyMd: scenes.bodyMd,
			summaryMd: scenes.summaryMd,
			summaryGeneratedAt: scenes.summaryGeneratedAt,
			updatedAt: scenes.updatedAt
		})
		.from(scenes)
		.innerJoin(stories, eq(stories.id, scenes.storyId))
		.where(
			and(eq(stories.universeId, universeId), isNull(stories.deletedAt), isNull(scenes.deletedAt))
		)
		.orderBy(asc(stories.positionInSeries), asc(scenes.globalPosition));
	return rows.map((scene) => {
		const stale = !summaryIsCurrent(scene.summaryGeneratedAt, scene.updatedAt);
		const blank = !scene.bodyMd.trim();
		return {
			id: scene.id,
			chapterId: scene.chapterId,
			name: `scene summary of ${label(scene.title, scene.id)}`,
			summaryMd: scene.summaryMd,
			blank,
			// The next summaries pass writes this scene's summary.
			due: !blank && (!scene.summaryMd?.trim() || (scene.summaryGeneratedAt !== null && stale)),
			input: buildSceneSummaryMessage(scene.title, scene.bodyMd),
			generated: scene.summaryGeneratedAt !== null,
			stale
		};
	});
}

// Entities the enrich pass would consider: mentioned in a live scene of a live
// story the Assistant reads.
async function enrichEligible(): Promise<Set<string>> {
	const { rows } = await pool.query(
		`select distinct m.target_id as id from entity_mentions m
		 join scenes s on s.id = m.source_id and s.deleted_at is null
		 join stories st on st.id = s.story_id and st.deleted_at is null
		 where m.source_type = 'scene' and st.universe_id = $1
		   and coalesce(st.llm_config ->> 'enabled', 'true') <> 'false'`,
		[universeId]
	);
	return new Set(rows.map((row: { id: string }) => row.id));
}

type EntityState = {
	kind: 'character' | 'place' | 'lore';
	id: string;
	name: string;
	enrichedAt: Date | null;
	enrichedInput: string | null;
};

async function entityStates(): Promise<EntityState[]> {
	const out: EntityState[] = [];
	for (const row of await db
		.select()
		.from(characters)
		.where(eq(characters.universeId, universeId))
		.orderBy(asc(characters.name)))
		out.push({
			kind: 'character',
			id: row.id,
			name: row.name,
			enrichedAt: row.assistantEnrichedAt,
			enrichedInput: row.assistantEnrichedInput
		});
	for (const row of await db
		.select()
		.from(places)
		.where(eq(places.universeId, universeId))
		.orderBy(asc(places.name)))
		out.push({
			kind: 'place',
			id: row.id,
			name: row.name,
			enrichedAt: row.assistantEnrichedAt,
			enrichedInput: row.assistantEnrichedInput
		});
	for (const row of await db
		.select()
		.from(loreEntries)
		.where(eq(loreEntries.universeId, universeId))
		.orderBy(asc(loreEntries.title)))
		out.push({
			kind: 'lore',
			id: row.id,
			name: row.title,
			enrichedAt: row.assistantEnrichedAt,
			enrichedInput: row.assistantEnrichedInput
		});
	return out;
}

const enrichMarked = (at: Date | null) => at === null || at < STALE_MARK_BEFORE;

// The passages of each entity's last enrich read, taken when its stored
// fingerprint matched. A trash or mute only takes passages away, and by design
// does not pay for a re-read; a re-read is owed when the request gains a
// passage it did not have. The entity's own name, aliases and details are the
// writer's to edit without paying for a re-read, so only passages count.
const enrichPassages = new Map<string, { passages: Set<string>; full: boolean }>();

// The passages of an enrich request, without their numbers: a removal
// renumbers the rest without adding any. A passage can run over a line break.
function passagesOf(request: { messages: { content: unknown }[] }): string[] {
	const text = request.messages.map((m) => String(m.content)).join('\n');
	const start = text.indexOf('Passages where it appears:\n');
	const end = text.indexOf('\n\nSuggest only');
	if (start < 0 || end < 0) return [];
	return text
		.slice(start + 'Passages where it appears:\n'.length, end)
		.split(/^\d+\. /m)
		.slice(1)
		.map((passage) => passage.replace(/\n$/, ''));
}

// Every passage an entity appears in, before the read's sample is taken, as
// snippet text without the story and scene label.
async function allSnippets(entity: EntityState): Promise<Set<string>> {
	const rows = await entityAppearances(
		db,
		{ kind: entity.kind, id: entity.id },
		{ universeId },
		{ assistant: true }
	);
	return new Set(rows.map((row) => row.snippet));
}
const unlabelled = (passage: string) => passage.replace(/^\[[^\]\n]*\] /, '');

// Runs the Assistant's background passes until everything it reads is current.
async function bringCurrent() {
	await settleMentions();
	for (const story of await liveStories()) {
		if (await storyMuted(story.id)) continue;
		await summariseStory(db, { userId, storyId: story.id }, deps);
	}
	for (const character of await db
		.select({
			id: characters.id,
			arcSummaryMd: characters.arcSummaryMd,
			arcSummaryAt: characters.arcSummaryAt
		})
		.from(characters)
		.where(eq(characters.universeId, universeId))
		.orderBy(asc(characters.name))) {
		if (character.arcSummaryMd && !arcIsStale(character)) continue;
		await summariseCharacterArc(db, { userId, characterId: character.id }, deps);
	}
	await enrichUniverse(db, { userId, universeId }, deps);

	for (const chapter of await chapterStates()) {
		const key = `${chapter.id}:${chapter.summaryMd}`;
		if (chapter.generated && !chapter.stale && !chapterScenes.has(key))
			chapterScenes.set(key, chapter.sceneIds);
	}
	for (const entity of await entityStates()) {
		const request = await enrichRequest(db, { userId, scope: { universeId }, entityId: entity.id });
		if (request && request.input === entity.enrichedInput) {
			const passages = passagesOf(request);
			enrichPassages.set(entity.id, {
				passages: new Set(passages),
				full: passages.length >= MAX_APPEARANCES
			});
		}
	}
}

type Finding = { rule: 'missed' | 'extra'; what: string; strict: boolean };

// `before` holds each entity's full set of snippets as of the step's start,
// for telling a sample shift from new prose.
async function checkMarks(before?: Map<string, Set<string>>): Promise<Finding[]> {
	const findings: Finding[] = [];
	const missed = (what: string, strict = true) => findings.push({ rule: 'missed', what, strict });
	const extra = (what: string, strict = true) => findings.push({ rule: 'extra', what, strict });

	// A summary is judged against the prompt it was written from. One whose
	// prompt is unknown (none here: the writer writes no summaries) is skipped.
	const judge = (
		item: { id: string; name: string; summaryMd: string | null; stale: boolean },
		input: string,
		opts: { owed?: (was: string) => boolean } = {}
	) => {
		const was = item.summaryMd ? writtenFrom.get(item.summaryMd.trim()) : undefined;
		if (was === undefined) return;
		const key = `${item.id}:${item.summaryMd}`;
		const changed = was !== input;
		if (changed) dirty.add(key);
		const owed = opts.owed ? opts.owed(was) : changed;
		if (owed && !item.stale) missed(item.name);
		if (!dirty.has(key) && item.stale) extra(item.name);
	};

	const scenesNow = await sceneStates();
	// A chapter holding a scene whose summary is due is marked by the pass that
	// writes it, so its own mark is judged after that pass.
	const chaptersWithDueScenes = new Set(
		scenesNow.filter((scene) => scene.due && scene.chapterId).map((scene) => scene.chapterId)
	);
	for (const scene of scenesNow) {
		if (!scene.generated || scene.blank) continue;
		judge(scene, scene.input, {
			// A duplicate keeps its source's current summary under the title
			// "X (copy)" rather than paying to summarise the same prose again
			// (#1089). Any other change of title or prose is owed a refresh.
			owed: (was) =>
				promptBody(was) !== promptBody(scene.input) ||
				uncopied(promptTitle(was)) !== uncopied(promptTitle(scene.input))
		});
	}
	for (const chapter of await chapterStates()) {
		// A chapter whose scenes came, went or moved is marked without reading
		// their summaries, so a mark is fine even when the input came out the
		// same (a scene with no summary yet, two equal summaries from a duplicate).
		// Like `dirty`, it holds once seen, even if a later step puts the scenes back.
		const key = `${chapter.id}:${chapter.summaryMd}`;
		const was = chapterScenes.get(key);
		if (was !== undefined && was !== chapter.sceneIds) dirty.add(key);
		if (!chapter.generated || chapter.input === null || chaptersWithDueScenes.has(chapter.id))
			continue;
		judge(chapter, chapter.input);
	}

	for (const character of await db
		.select({
			id: characters.id,
			name: characters.name,
			universeId: characters.universeId,
			arcSummaryMd: characters.arcSummaryMd,
			arcSummaryAt: characters.arcSummaryAt,
			arcSummaryInput: characters.arcSummaryInput
		})
		.from(characters)
		.where(eq(characters.universeId, universeId))
		.orderBy(asc(characters.name))) {
		if (!character.arcSummaryMd) continue;
		const request = await arcRequest(db, character);
		const changed = (request?.input ?? null) !== character.arcSummaryInput;
		const stale = arcIsStale(character);
		if (changed && !stale) missed(`arc of ${character.name}`);
		// No paid call: the arc pass skips a request the same as the last.
		if (!changed && stale) extra(`arc of ${character.name}`, false);
	}

	const eligible = await enrichEligible();
	for (const entity of await entityStates()) {
		if (!eligible.has(entity.id) || entity.enrichedInput === null) continue;
		const request = await enrichRequest(db, { userId, scope: { universeId }, entityId: entity.id });
		const changed = request?.input !== entity.enrichedInput;
		const marked = enrichMarked(entity.enrichedAt);
		const what = `enrich of ${entity.kind} ${entity.name}`;
		if (!changed && marked) extra(what, false);
		if (!changed || marked) continue;
		const last = enrichPassages.get(entity.id);
		if (!request || !last) {
			missed(what);
			continue;
		}
		const gained = passagesOf(request).filter((passage) => !last.passages.has(passage));
		if (!gained.length) continue;
		// A read sends at most MAX_APPEARANCES passages. When the last one was
		// full, taking a passage away can bring in one that was left out of it
		// though already written; that waits for the next real change (#1201).
		const shifted =
			last.full && gained.every((passage) => before?.get(entity.id)?.has(unlabelled(passage)));
		missed(`${what}${shifted ? ' (sample shift)' : ''} (new: ${gained.join(' | ')})`, !shifted);
	}
	return findings;
}

// updated_at is the app clock at millisecond precision, and a summary is
// current while its stamp is at or after it; two writes in one millisecond
// would read as one. Real edits are further apart than that.
const nextMillisecond = () => new Promise((resolve) => setTimeout(resolve, 2));

describe('Assistant stale marks follow what the Assistant reads', () => {
	// The actions that applied in at least one seed.
	const ran = new Set<string>();
	const seeds = Array.from({ length: SEEDS }, (_, i) => i + 1);

	it.each(seeds)('seed %i', { timeout: 300_000 }, async (seed) => {
		const r = rng(seed);
		writtenFrom.clear();
		dirty.clear();
		chapterScenes.clear();
		enrichPassages.clear();
		chapterCount = 0;
		draftCount = 0;
		await seedWorld(r);
		await bringCurrent();
		// The passes themselves must leave nothing out of date.
		expect(await checkMarks(), 'after the first pass').toEqual([]);

		const log: string[] = [];
		// Actions that only apply in a state few steps leave behind get a second
		// draw, so the default seeds reach them.
		const names = [...Object.keys(actions), ...RARE];
		const soft: string[] = [];
		const fail = (when: string, findings: Finding[]) =>
			expect.fail(
				[
					`seed ${seed}, ${when}`,
					...findings.map(
						(f) => `  ${f.rule === 'missed' ? 'not marked' : 'marked needlessly'}: ${f.what}`
					),
					'after:',
					...log.map((line, i) => `  ${i + 1}. ${line}`)
				].join('\n')
			);
		for (let step = 0; step < STEPS; step++) {
			const name = r.pick(names)!;
			const snippets = new Map<string, Set<string>>();
			for (const entity of await entityStates()) snippets.set(entity.id, await allSnippets(entity));
			await nextMillisecond();
			const did = await actions[name](r);
			if (!did) continue;
			ran.add(name);
			log.push(did);
			await settleMentions();
			let findings = await checkMarks(snippets);
			if (findings.some((f) => f.strict))
				fail(
					`step ${step + 1}: ${did}`,
					findings.filter((f) => f.strict)
				);
			soft.push(...findings.map((f) => `${did}: ${f.rule} ${f.what}`));
			await bringCurrent();
			// What the passes wrote, and what they marked while writing it.
			findings = await checkMarks(snippets);
			if (findings.some((f) => f.strict))
				fail(
					`the passes after step ${step + 1}`,
					findings.filter((f) => f.strict)
				);
		}
		if (soft.length) console.info(`seed ${seed}: not failed\n  ${soft.join('\n  ')}`);
	});

	// A write path that never applies is not being checked at all. The default
	// seeds reach every one; a narrower run is not held to that.
	it.skipIf(SEEDS < 8)('every action ran in some seed', () => {
		expect(Object.keys(actions).filter((name) => !ran.has(name))).toEqual([]);
	});
});
