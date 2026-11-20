// The Assistant's cached work (character arcs, enrich reads, chapter
// summaries) is out of date exactly when the request it would be written from
// now differs from the one it was written from. Nothing marks it: each is
// stored with a fingerprint of its request, compared when it is read or when
// a pass runs. This test applies seeded random sequences of writer actions
// through the real server functions and, after each one, checks against the
// requests the stub provider was actually sent:
//
// - whenever a stored arc's or chapter summary's request changed, the Plan
//   page and the context read it as out of date, and whenever it did not,
//   as current;
// - the passes then make a model call for exactly the arcs, chapter summaries
//   and enrich reads whose request changed, and a second pass makes none;
// - no save writes the columns the Assistant's jobs own;
// - no context carries an arc that retells a story the Assistant is now
//   turned off for.
//
// Scene summaries read only their own row and keep their timestamp rule; the
// same run checks that a changed one reads as stale and an untouched one does
// not.
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
import { chapterSummaryRequest } from '../../src/lib/server/llm/chapter-summary-request';
import { buildSceneSummaryMessage } from '../../src/lib/server/llm/prompts/summary';
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

const { planArc, summariseCharacterArc } = await import('../../src/lib/server/llm/arc-summary');
const { arcRequest } = await import('../../src/lib/server/llm/arc-request');
const { enrichRequest, enrichUniverse } = await import('../../src/lib/server/llm/enrich');
const { storySkeleton } = await import('../../src/lib/server/llm/context/sources');
const { assembleContext } = await import('../../src/lib/server/llm/context/assemble');
const { summariseStory } = await import('../../src/lib/server/llm/summaries');
const { saveAccountLlmConfig, saveStoryLlmOverride } =
	await import('../../src/lib/server/llm/config');

let chapterCount = 0;
let draftCount = 0;

const SEEDS = Number(process.env.STALE_SEEDS ?? 8);
const STEPS = Number(process.env.STALE_STEPS ?? 30);
// Seeds added after the chosen ones while some action has yet to apply.
const EXTRA_SEEDS = 8;

const hash = (text: string) => createHash('sha256').update(text).digest('hex');

// Every request the stub was sent since `sent` was last cleared, as JSON.
let sent: string[] = [];

// Replies with text that follows the request, so a summary written from a
// different input reads differently (and moves what reads it). Not JSON, so
// an enrich read stages nothing.
const stubProvider: Provider = {
	async *chatStream() {
		yield { type: 'done' };
	},
	async respond(req) {
		// Less the persona the gateway puts first, which no fingerprint covers.
		const messagesJson = JSON.stringify(req.messages.slice(1));
		sent.push(messagesJson);
		const prompt = req.messages.map((m) => String(m.content)).join('\n');
		const content = replyTo(messagesJson);
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
	const by = <T extends { name: string; id: string }>(rows: T[]) =>
		rows.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
	for (const row of by(
		await db
			.select({ id: characters.id, name: characters.name })
			.from(characters)
			.where(eq(characters.universeId, universeId))
	))
		out.push({ kind: 'character', ...row });
	for (const row of by(
		await db
			.select({ id: places.id, name: places.name })
			.from(places)
			.where(eq(places.universeId, universeId))
	))
		out.push({ kind: 'place', ...row });
	for (const row of by(
		await db
			.select({ id: loreEntries.id, name: loreEntries.title })
			.from(loreEntries)
			.where(eq(loreEntries.universeId, universeId))
	))
		out.push({ kind: 'lore', ...row });
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
// The Assistant's side: what it would be sent now, what it was sent, and how
// the app reads each stored result.

// The stub's reply to a request. A stored arc or chapter summary is this text,
// so the text itself says which request it was written from.
const replyTo = (messagesJson: string) => `Summary ${hash(messagesJson).slice(0, 8)}.`;

// A scene summary is current by its row's timestamps, not a fingerprint, so
// the stub keeps the prompt each reply was written from, keyed by the reply. A
// copied summary (split, duplicate) carries its source's text, so it maps to
// its source's prompt.
const writtenFrom = new Map<string, string>();

// Scene summaries whose input differed from what they were written from at
// some step since, even if a later step put it back (a swap undone): they are
// owed a refresh. Keyed by id and summary text, so a new summary starts clean.
const dirty = new Set<string>();

// The request each entity's last enrich read sent, as the provider received
// it. An enrich read leaves no text behind to tell it by.
const enrichSent = new Map<string, string>();

// An enrich request less the parts the fingerprint leaves out on purpose:
// what is recorded on the entry (its aliases and details, and whether a
// summary is asked for). Accepting what a read suggested would otherwise put
// the read out of date.
const enrichCanon = (messagesJson: string) => {
	const messages = JSON.parse(messagesJson) as { role: string; content: string }[];
	return JSON.stringify(
		messages.map((message) => ({
			...message,
			content: message.content
				.replace(/\n[\s\S]*?\n\nPassages where it appears:/, '\n\nPassages where it appears:')
				.replace(
					'- do not propose a summary; it already has one.',
					'- a one or two sentence summary of who or what it is.'
				)
				.replace(
					'Use "summary": null. Use empty arrays',
					'Use "summary": null if you cannot summarise it. Use empty arrays'
				)
		}))
	);
};

const isChapterRequest = (messagesJson: string) =>
	messagesJson.includes('drawing on its scene summaries below');
const isEnrichRequest = (messagesJson: string) => messagesJson.includes('Enrich the ');
const isArcRequest = (messagesJson: string) =>
	messagesJson.includes('Write a short account of what happens to the character');

const label = (title: string | null, id: string) => title ?? `untitled ${id.slice(0, 4)}`;

// The prose a scene summary prompt carries, after its "---" line.
const promptBody = (prompt: string) => prompt.slice(prompt.indexOf('\n---\n') + 5);
const promptTitle = (prompt: string) => prompt.slice(0, prompt.indexOf('\n'));
const uncopied = (title: string) => title.replaceAll(' (copy)', '');

// Each chapter of a live story: the request its summary would be written from
// now, and how the context builder reads the stored one.
async function chapterStates() {
	const out = [];
	for (const story of await liveStories()) {
		const rows = await db
			.select({
				id: chapters.id,
				title: chapters.title,
				summaryMd: chapters.summaryMd,
				summaryGeneratedAt: chapters.summaryGeneratedAt
			})
			.from(chapters)
			.where(eq(chapters.storyId, story.id))
			.orderBy(asc(chapters.position));
		const skeleton = await storySkeleton(db, story.id);
		for (const chapter of rows) {
			const sceneRows = await db
				.select({ summaryMd: scenes.summaryMd })
				.from(scenes)
				.where(and(eq(scenes.chapterId, chapter.id), isNull(scenes.deletedAt)))
				.orderBy(asc(scenes.globalPosition));
			const request = chapterSummaryRequest(
				chapter.title,
				sceneRows.map((s) => s.summaryMd)
			);
			out.push({
				id: chapter.id,
				storyId: story.id,
				name: `chapter summary of ${label(chapter.title, chapter.id)}`,
				summaryMd: chapter.summaryMd,
				generated: chapter.summaryGeneratedAt !== null,
				now: request ? JSON.stringify(request.messages) : null,
				// The context leaves an out-of-date summary out.
				shownStale: skeleton.chapters.find((c) => c.id === chapter.id)!.summaryMd === null
			});
		}
	}
	return out;
}

async function arcStates() {
	const out = [];
	for (const entity of await db
		.select()
		.from(characters)
		.where(eq(characters.universeId, universeId))
		.orderBy(asc(characters.name), asc(characters.id))) {
		const request = await arcRequest(db, entity);
		out.push({
			id: entity.id,
			name: `arc of ${entity.name}`,
			summaryMd: entity.arcSummaryMd,
			generated: true,
			now: request ? JSON.stringify(request.messages) : null,
			shownStale: (await planArc(db, { kind: 'character', entity }))!.stale
		});
	}
	return out;
}

async function sceneStates() {
	const rows = await db
		.select({
			id: scenes.id,
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
	return rows.map((scene) => ({
		id: scene.id,
		name: `scene summary of ${label(scene.title, scene.id)}`,
		summaryMd: scene.summaryMd,
		blank: !scene.bodyMd.trim(),
		input: buildSceneSummaryMessage(scene.title, scene.bodyMd),
		generated: scene.summaryGeneratedAt !== null,
		stale: !summaryIsCurrent(scene.summaryGeneratedAt, scene.updatedAt)
	}));
}

// The entities the enrich pass looks at (mentioned in a live scene of a live
// story the Assistant reads), each with the request it would send now.
async function enrichStates() {
	const { rows } = await pool.query(
		`select distinct m.target_id as id from entity_mentions m
		 join scenes s on s.id = m.source_id and s.deleted_at is null
		 join stories st on st.id = s.story_id and st.deleted_at is null
		 where m.source_type = 'scene' and st.universe_id = $1
		   and coalesce(st.llm_config ->> 'enabled', 'true') <> 'false'`,
		[universeId]
	);
	const out = [];
	for (const { id } of rows as { id: string }[]) {
		const request = await enrichRequest(db, { userId, scope: { universeId }, entityId: id });
		if (request) out.push({ id, now: enrichCanon(JSON.stringify(request.messages)) });
	}
	return out;
}

// The hash rule, as the writer and the Assistant's context see it: a stored
// arc or chapter summary reads as out of date exactly when the request it
// would be written from now is not the one it was written from. Scene
// summaries keep their timestamp rule: a changed one must read as stale, and
// one whose input never changed must not.
async function checkReads(): Promise<string[]> {
	const findings: string[] = [];
	for (const item of [...(await arcStates()), ...(await chapterStates())]) {
		if (!item.summaryMd || !item.generated) continue;
		const changed = item.now === null || replyTo(item.now) !== item.summaryMd.trim();
		if (changed && !item.shownStale) findings.push(`shown as current: ${item.name}`);
		if (!changed && item.shownStale) findings.push(`shown as out of date: ${item.name}`);
	}
	for (const scene of await sceneStates()) {
		if (!scene.generated || scene.blank || !scene.summaryMd) continue;
		const was = writtenFrom.get(scene.summaryMd.trim());
		if (was === undefined) continue;
		const key = `${scene.id}:${scene.summaryMd}`;
		if (was !== scene.input) dirty.add(key);
		// A duplicate keeps its source's current summary under the title
		// "X (copy)" rather than paying to summarise the same prose again
		// (#1089). Any other change of title or prose is owed a refresh.
		const owed =
			promptBody(was) !== promptBody(scene.input) ||
			uncopied(promptTitle(was)) !== uncopied(promptTitle(scene.input));
		if (owed && !scene.stale) findings.push(`shown as current: ${scene.name}`);
		if (!dirty.has(key) && scene.stale) findings.push(`shown as out of date: ${scene.name}`);
	}
	return findings;
}

// Runs the Assistant's background passes and checks what they paid for: a
// model call for every arc, chapter summary and enrich read whose request
// changed, and for nothing else.
async function runPasses(): Promise<string[]> {
	const findings: string[] = [];
	const compare = (what: string, actual: string[], expected: string[]) => {
		const a = [...actual].sort();
		const e = [...expected].sort();
		if (a.length !== e.length || a.some((item, i) => item !== e[i]))
			findings.push(`${what}: ${a.length} model calls, ${e.length} requests had changed`);
	};
	await settleMentions();

	// Summaries. The chapter requests are final once the scene pass has run, so
	// what was owed is worked out from the stored text as it was before.
	const before = new Map((await chapterStates()).map((chapter) => [chapter.id, chapter]));
	const passed = new Set<string>();
	sent = [];
	for (const story of await liveStories()) {
		if (await storyMuted(story.id)) continue;
		passed.add(story.id);
		await summariseStory(db, { userId, storyId: story.id }, deps);
	}
	const owedChapters = (await chapterStates()).filter((chapter) => {
		const was = before.get(chapter.id);
		if (!was || !passed.has(chapter.storyId) || chapter.now === null) return false;
		return !was.summaryMd?.trim() || (was.generated && replyTo(chapter.now) !== was.summaryMd);
	});
	compare(
		'chapter summaries',
		sent.filter(isChapterRequest),
		owedChapters.map((chapter) => chapter.now!)
	);

	// Arcs are written when the writer asks: here, for every arc not written
	// yet and every one the Plan page shows as out of date.
	const arcs = await arcStates();
	sent = [];
	for (const arc of arcs) {
		if (arc.summaryMd && !arc.shownStale) continue;
		const read = await storiesAnArcReads(arc.id);
		await summariseCharacterArc(db, { userId, characterId: arc.id }, deps);
		const [written] = await db
			.select({ text: characters.arcSummaryMd })
			.from(characters)
			.where(eq(characters.id, arc.id));
		if (written?.text) arcStories.set(written.text.trim(), read);
	}
	compare(
		'arcs',
		sent.filter(isArcRequest),
		arcs
			.filter((arc) => arc.now !== null && (!arc.summaryMd || replyTo(arc.now) !== arc.summaryMd))
			.map((arc) => arc.now!)
	);

	const owedReads = (await enrichStates()).filter(
		(entity) => enrichSent.get(entity.id) !== entity.now
	);
	sent = [];
	await enrichUniverse(db, { userId, universeId }, deps);
	compare(
		'enrich reads',
		sent.filter(isEnrichRequest).map(enrichCanon),
		owedReads.map((entity) => entity.now)
	);
	for (const entity of owedReads) enrichSent.set(entity.id, entity.now);

	// With everything current, the passes ask the model nothing.
	sent = [];
	for (const storyId of passed) await summariseStory(db, { userId, storyId }, deps);
	await enrichUniverse(db, { userId, universeId }, deps);
	if (sent.length) findings.push(`a second pass made ${sent.length} model calls`);
	return findings;
}

// The stories each arc text retells: those with a live scene mentioning the
// character, in a live story the Assistant read, when the arc was written.
const arcStories = new Map<string, string[]>();

async function storiesAnArcReads(characterId: string): Promise<string[]> {
	const { rows } = await pool.query(
		`select distinct st.id from entity_mentions m
		 join scenes s on s.id = m.source_id and s.deleted_at is null
		 join stories st on st.id = s.story_id and st.deleted_at is null
		 where m.source_type = 'scene' and m.target_id = $1
		   and coalesce(st.llm_config ->> 'enabled', 'true') <> 'false'`,
		[characterId]
	);
	return rows.map((row: { id: string }) => row.id);
}

// Text of a story the Assistant is turned off for must not reach the model
// through an arc that retold it. Checked on the universe's context, which
// carries every character, whenever some story is muted.
async function checkMutedArcs(): Promise<string[]> {
	const { rows } = await pool.query(
		`select id from stories where universe_id = $1 and llm_config ->> 'enabled' = 'false'`,
		[universeId]
	);
	const muted = new Set(rows.map((row: { id: string }) => row.id));
	if (!muted.size) return [];
	const context = await assembleContext(db, { userId, universeId });
	const findings: string[] = [];
	for (const [text, read] of arcStories) {
		if (context!.text.includes(text) && read.some((id) => muted.has(id)))
			findings.push(`sent an arc that retells a muted story: ${text}`);
	}
	return findings;
}

// The columns the Assistant's jobs own. No save may write them: a save that
// did would be doing the Assistant's bookkeeping, and taking its locks.
async function assistantColumns(): Promise<Map<string, string>> {
	const { rows } = await pool.query(`
		select 'character ' || id as key, concat_ws('|', arc_summary_md, arc_summary_at,
			arc_summary_input, assistant_enriched_at, assistant_enriched_input) as value from characters
		union all select 'place ' || id, concat_ws('|', assistant_enriched_at, assistant_enriched_input)
			from places
		union all select 'lore ' || id, concat_ws('|', assistant_enriched_at, assistant_enriched_input)
			from lore_entries
		union all select 'chapter ' || id, concat_ws('|', summary_md, summary_generated_at, summary_input)
			from chapters`);
	return new Map(rows.map((row: { key: string; value: string }) => [row.key, row.value]));
}

// updated_at is the app clock at millisecond precision, and a scene summary is
// current while its stamp is at or after it; two writes in one millisecond
// would read as one. Real edits are further apart than that.
const nextMillisecond = () => new Promise((resolve) => setTimeout(resolve, 2));

describe('Assistant results are out of date exactly when their request changed', () => {
	// The actions that applied in at least one seed.
	const ran = new Set<string>();
	const seeds = Array.from({ length: SEEDS }, (_, i) => i + 1);

	async function runSeed(seed: number) {
		const r = rng(seed);
		writtenFrom.clear();
		arcStories.clear();
		dirty.clear();
		enrichSent.clear();
		chapterCount = 0;
		draftCount = 0;
		await seedWorld(r);

		const log: string[] = [];
		const check = (when: string, findings: string[]) => {
			if (!findings.length) return;
			expect.fail(
				[
					`seed ${seed}, ${when}`,
					...findings.map((finding) => `  ${finding}`),
					'after:',
					...log.map((line, i) => `  ${i + 1}. ${line}`)
				].join('\n')
			);
		};
		check('the first passes', await runPasses());
		check('after the first passes', await checkReads());

		// Actions that only apply in a state few steps leave behind get a second
		// draw, so the default seeds reach them.
		const names = [...Object.keys(actions), ...RARE];
		for (let step = 0; step < STEPS; step++) {
			const name = r.pick(names)!;
			const columns = await assistantColumns();
			await nextMillisecond();
			const did = await actions[name](r);
			if (!did) continue;
			ran.add(name);
			log.push(did);
			await settleMentions();
			const touched = [...(await assistantColumns())].filter(
				([key, value]) => columns.has(key) && columns.get(key) !== value
			);
			check(
				`step ${step + 1}: ${did}`,
				touched.map(([key]) => `the save wrote Assistant columns of ${key}`)
			);
			check(`step ${step + 1}: ${did}`, await checkReads());
			check(`step ${step + 1}: ${did}`, await checkMutedArcs());
			check(`the passes after step ${step + 1}`, await runPasses());
			check(`after the passes after step ${step + 1}`, await checkReads());
		}
	}

	it.each(seeds)('seed %i', { timeout: 300_000 }, runSeed);

	// A write path that never applies is not being checked at all. All picks
	// come from one stream, so adding an action moves every seed's picks and can
	// leave a rarely applicable one out of the default seeds; further seeds then
	// run until each has applied. A run narrowed by STALE_SEEDS or STALE_STEPS
	// is not held to this.
	it.skipIf(SEEDS < 8 || STEPS < 30)(
		'every action ran in some seed',
		{ timeout: EXTRA_SEEDS * 300_000 },
		async () => {
			const missing = () => Object.keys(actions).filter((name) => !ran.has(name));
			for (let seed = SEEDS + 1; missing().length && seed <= SEEDS + EXTRA_SEEDS; seed++)
				await runSeed(seed);
			expect(missing()).toEqual([]);
		}
	);
});
