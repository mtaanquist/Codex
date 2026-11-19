// The Assistant's cached work (character arcs, enrich reads, scene and chapter
// summaries) is refreshed only when it is marked out of date, and every write
// path marks by hand. This test applies seeded random sequences of writer
// actions through the real server functions and, after each one, checks the
// marks against what the Assistant would actually be sent:
//
// - whatever's input changed must be marked (a missed mark leaves the writer
//   with an arc or summary describing text that is no longer there); for an
//   enrich read, only a passage it has not read yet counts, since a trash or
//   mute that only takes passages away is not worth a paid re-read, and
// - a scene or chapter summary whose input did not change must not be marked
//   (summaries have no fingerprint check, so a needless mark is a paid call).
//
// Arcs and enrich reads carry a fingerprint of their last request and skip the
// call when it matches, so a needless mark there costs no model call; those are
// counted and reported, not failed.
//
// A failure prints the seed and the actions that led to it. STALE_SEEDS and
// STALE_STEPS widen a local run.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { and, asc, eq, isNull, isNotNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	chapters,
	characters,
	loreEntries,
	places,
	scenes,
	stories,
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

// Storing the account API key encrypts it with APP_SECRET.
process.env.APP_SECRET = process.env.APP_SECRET || 'stale-marks-invariant-secret';

const { arcIsStale, arcRequest, summariseCharacterArc } =
	await import('../../src/lib/server/llm/arc-summary');
const { enrichRequest, enrichUniverse } = await import('../../src/lib/server/llm/enrich');
const { summariseStory } = await import('../../src/lib/server/llm/summaries');
const { saveAccountLlmConfig, saveStoryLlmOverride } =
	await import('../../src/lib/server/llm/config');

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
		return {
			content: `Summary ${hash(JSON.stringify(req.messages)).slice(0, 8)}.`,
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
		'truncate table assistant_job_spend, entity_mentions, scenes, chapters, characters, places, lore_entries, stories, universes, users cascade'
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
			.orderBy(asc(stories.positionInSeries), asc(scenes.globalPosition));
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
		await renameChapter(db, userId, chapter.id, `Chapter ${r.int(100)}`);
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
			.orderBy(sql.raw(kind === 'lore' ? 'title' : 'name'));
		const target = r.pick(rows);
		if (!target) return null;
		const current = await loadEntity(kind, target.id);
		const change = r.pick(['name', 'tags', 'details', 'summary', 'body'] as const)!;
		const next = { ...current };
		if (change === 'name') next.name = `${current.name.split(' ')[0]} ${r.int(100)}`;
		if (change === 'tags') next.tags = r.chance(0.5) ? [] : [`the ${r.pick(['old', 'young'])} one`];
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

// The prompt each generated summary was written from, taken when it was last
// brought current. Summaries store no fingerprint of their own, so the test
// keeps one.
const summaryInputs = new Map<string, string>();
// Summaries whose input differed from that at some step since, even if a later
// step put it back (a swap undone): their mark is owed.
const summaryDirty = new Set<string>();

async function chapterSummaryInputs(): Promise<
	Map<
		string,
		{
			title: string | null;
			input: string | null;
			stale: boolean;
			generated: boolean;
			storyId: string;
			repeats: boolean;
		}
	>
> {
	const rows = await db
		.select({
			id: chapters.id,
			storyId: chapters.storyId,
			title: chapters.title,
			summaryGeneratedAt: chapters.summaryGeneratedAt,
			updatedAt: chapters.updatedAt
		})
		.from(chapters)
		.innerJoin(stories, eq(stories.id, chapters.storyId))
		.where(and(eq(stories.universeId, universeId), isNull(stories.deletedAt)));
	const out = new Map();
	for (const chapter of rows) {
		const summaries = (
			await db
				.select({ summaryMd: scenes.summaryMd })
				.from(scenes)
				.where(and(eq(scenes.chapterId, chapter.id), isNull(scenes.deletedAt)))
				.orderBy(asc(scenes.globalPosition))
		)
			.map((s) => s.summaryMd?.trim())
			.filter((s): s is string => !!s);
		out.set(chapter.id, {
			title: chapter.title,
			storyId: chapter.storyId,
			// A duplicate keeps its source's summary, so two scenes can read the
			// same; swapping them is a reorder that does not change the input.
			repeats: new Set(summaries).size < summaries.length,
			// A chapter with no scene summaries is passed over, not refreshed.
			input: summaries.length ? buildChapterSummaryMessage(chapter.title, summaries) : null,
			generated: chapter.summaryGeneratedAt !== null,
			stale: !summaryIsCurrent(chapter.summaryGeneratedAt, chapter.updatedAt)
		});
	}
	return out;
}

async function sceneSummaryStates() {
	const rows = await db
		.select({
			id: scenes.id,
			storyId: scenes.storyId,
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
		);
	return rows.map((scene) => ({
		id: scene.id,
		storyId: scene.storyId,
		chapterId: scene.chapterId,
		title: scene.title,
		blank: !scene.bodyMd.trim(),
		// The next summaries pass writes this scene's summary.
		due:
			!!scene.bodyMd.trim() &&
			(!scene.summaryMd?.trim() ||
				(scene.summaryGeneratedAt !== null &&
					!summaryIsCurrent(scene.summaryGeneratedAt, scene.updatedAt))),
		input: buildSceneSummaryMessage(scene.title, scene.bodyMd),
		generated: scene.summaryGeneratedAt !== null,
		stale: !summaryIsCurrent(scene.summaryGeneratedAt, scene.updatedAt)
	}));
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

async function entityStates() {
	const out: {
		kind: 'character' | 'place' | 'lore';
		id: string;
		name: string;
		enrichedAt: Date | null;
		enrichedInput: string | null;
	}[] = [];
	for (const row of await db.select().from(characters).where(eq(characters.universeId, universeId)))
		out.push({
			kind: 'character',
			id: row.id,
			name: row.name,
			enrichedAt: row.assistantEnrichedAt,
			enrichedInput: row.assistantEnrichedInput
		});
	for (const row of await db.select().from(places).where(eq(places.universeId, universeId)))
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
		.where(eq(loreEntries.universeId, universeId)))
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

// The passages of each entity's last enrich request, taken when its stored
// fingerprint matched. A trash, merge or mute only takes passages away, and by
// design does not pay for a re-read (the suggestions already staged came from
// text the writer can still see in History); a re-read is owed when the
// request gains a line it did not have.
const enrichLines = new Map<string, Set<string>>();

// Whether that request held as many passages as a read sends
// (MAX_APPEARANCES in enrich.ts).
const enrichFull = new Map<string, boolean>();
const ENRICH_SAMPLE = 16;

const requestLines = (request: { messages: { content: unknown }[] }) =>
	new Set(passageLines(request));

const passageLines = (request: { messages: { content: unknown }[] }) =>
	request.messages.flatMap((m) =>
		// Only the numbered passage lines: the entity's own name, aliases and
		// details are the writer's to edit without paying for a re-read, and a
		// removal renumbers the rest without adding any.
		String(m.content)
			.split('\n')
			.filter((line) => /^\d+\. /.test(line))
			.map((line) => line.replace(/^\d+\. /, ''))
	);

// Runs the Assistant's background passes until everything it reads is current,
// and records the summary fingerprints the next check compares against.
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
		.where(eq(characters.universeId, universeId))) {
		if (character.arcSummaryMd && !arcIsStale(character)) continue;
		await summariseCharacterArc(db, { userId, characterId: character.id }, deps);
	}
	await enrichUniverse(db, { userId, universeId }, deps);

	for (const scene of await sceneSummaryStates()) {
		if (scene.generated && !scene.stale) {
			summaryInputs.set(scene.id, scene.input);
			summaryDirty.delete(scene.id);
		}
	}
	for (const [id, chapter] of await chapterSummaryInputs()) {
		if (chapter.generated && !chapter.stale && chapter.input) {
			summaryInputs.set(id, chapter.input);
			summaryDirty.delete(id);
		}
	}
	for (const entity of await entityStates()) {
		const request = await enrichRequest(db, { userId, scope: { universeId }, entityId: entity.id });
		if (request && request.input === entity.enrichedInput) {
			enrichLines.set(entity.id, requestLines(request));
			enrichFull.set(entity.id, passageLines(request).length >= ENRICH_SAMPLE);
		}
	}
}

type Finding = { rule: 'missed' | 'extra'; what: string; strict: boolean };

async function checkMarks(): Promise<Finding[]> {
	const findings: Finding[] = [];
	const muted = new Set<string>();
	for (const story of await liveStories()) if (await storyMuted(story.id)) muted.add(story.id);

	const sceneStates = await sceneSummaryStates();
	// A chapter holding a scene whose summary is due is marked by the pass that
	// writes it, so its own mark is not judged until then.
	const chaptersWithDueScenes = new Set(
		sceneStates.filter((scene) => scene.due && scene.chapterId).map((scene) => scene.chapterId)
	);
	for (const scene of sceneStates) {
		if (!scene.generated || scene.blank) continue;
		const was = summaryInputs.get(scene.id);
		// A copy (split, duplicate) inherits a stamp; compare it with the input
		// it was copied from only when that is known.
		if (was === undefined) continue;
		const changed = was !== scene.input;
		if (changed) summaryDirty.add(scene.id);
		if (changed && !scene.stale)
			findings.push({ rule: 'missed', what: `scene summary ${scene.title}`, strict: true });
		if (!summaryDirty.has(scene.id) && scene.stale && !muted.has(scene.storyId))
			findings.push({ rule: 'extra', what: `scene summary ${scene.title}`, strict: true });
	}
	for (const [id, chapter] of await chapterSummaryInputs()) {
		// A chapter left with no scene summaries is passed over and keeps any
		// mark; what it is compared with starts again at its next summary.
		if (chapter.input === null) summaryInputs.delete(id);
		if (!chapter.generated || chapter.input === null || chaptersWithDueScenes.has(id)) continue;
		const was = summaryInputs.get(id);
		if (was === undefined) continue;
		const changed = was !== chapter.input;
		if (changed) summaryDirty.add(id);
		if (changed && !chapter.stale)
			findings.push({ rule: 'missed', what: `chapter summary of ${chapter.title}`, strict: true });
		if (!summaryDirty.has(id) && chapter.stale && !muted.has(chapter.storyId) && !chapter.repeats)
			findings.push({ rule: 'extra', what: `chapter summary of ${chapter.title}`, strict: true });
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
		.where(eq(characters.universeId, universeId))) {
		if (!character.arcSummaryMd) continue;
		const request = await arcRequest(db, character);
		const changed = (request?.input ?? null) !== character.arcSummaryInput;
		const stale = arcIsStale(character);
		if (changed && !stale)
			findings.push({ rule: 'missed', what: `arc of ${character.name}`, strict: true });
		if (!changed && stale)
			findings.push({ rule: 'extra', what: `arc of ${character.name}`, strict: false });
	}

	const eligible = await enrichEligible();
	for (const entity of await entityStates()) {
		if (!eligible.has(entity.id) || entity.enrichedInput === null) continue;
		const request = await enrichRequest(db, {
			userId,
			scope: { universeId },
			entityId: entity.id
		});
		const changed = request?.input !== entity.enrichedInput;
		const before = enrichLines.get(entity.id);
		const gained =
			!request || !before || [...requestLines(request)].some((line) => !before.has(line));
		const marked = enrichMarked(entity.enrichedAt);
		// A read sends at most ENRICH_SAMPLE passages. When it was full, taking
		// one away can bring in a passage that was left out before; that waits
		// for the next real change (a known gap, #1201), so it is reported, not failed.
		const sampled = enrichFull.get(entity.id) ?? false;
		if (changed && gained && !marked && sampled) {
			findings.push({
				rule: 'missed',
				what: `enrich of ${entity.name} (sample shift)`,
				strict: false
			});
		} else if (changed && gained && !marked)
			findings.push({
				rule: 'missed',
				what: `enrich of ${entity.kind} ${entity.name}${
					request && before
						? ` (new: ${[...requestLines(request)].filter((l) => !before.has(l)).join(' | ')})`
						: ''
				}`,
				strict: true
			});
		if (!changed && marked)
			findings.push({
				rule: 'extra',
				what: `enrich of ${entity.kind} ${entity.name}`,
				strict: false
			});
	}
	return findings;
}

// updated_at is the app clock at millisecond precision, and a summary is
// current while its stamp is at or after it; two writes in one millisecond
// would read as one. Real edits are further apart than that.
const nextMillisecond = () => new Promise((resolve) => setTimeout(resolve, 2));

describe('Assistant stale marks follow what the Assistant reads', () => {
	const seeds = Array.from({ length: SEEDS }, (_, i) => i + 1);

	it.each(seeds)('seed %i', { timeout: 120_000 }, async (seed) => {
		const r = rng(seed);
		summaryInputs.clear();
		summaryDirty.clear();
		enrichLines.clear();
		enrichFull.clear();
		await seedWorld(r);
		await bringCurrent();
		// The passes themselves must leave nothing out of date.
		expect(await checkMarks(), 'after the first pass').toEqual([]);

		const log: string[] = [];
		const names = Object.keys(actions);
		const soft: string[] = [];
		for (let step = 0; step < STEPS; step++) {
			const name = r.pick(names)!;
			await nextMillisecond();
			const did = await actions[name](r);
			if (!did) continue;
			log.push(did);
			await settleMentions();
			const findings = await checkMarks();
			const strict = findings.filter((f) => f.strict);
			if (strict.length) {
				expect.fail(
					[
						`seed ${seed}, step ${step + 1}: ${did}`,
						...strict.map(
							(f) => `  ${f.rule === 'missed' ? 'not marked' : 'marked needlessly'}: ${f.what}`
						),
						'after:',
						...log.map((line, i) => `  ${i + 1}. ${line}`)
					].join('\n')
				);
			}
			soft.push(...findings.map((f) => `${did}: ${f.what}`));
			await nextMillisecond();
			await bringCurrent();
		}
		if (soft.length)
			console.info(`seed ${seed}: needless marks (no paid call)\n  ${soft.join('\n  ')}`);
	});
});
