import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	characters,
	entityMentions,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import type { GatewayDeps } from '../../src/lib/server/llm/gateway';
import type { HttpRequest, Provider } from '../../src/lib/server/llm/providers/types';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';
import { restoreScene, STALE_MARK_BEFORE, trashScene } from '../../src/lib/server/scene-lifecycle';
import { standaloneUniverse } from '../../src/lib/server/story-create';
import { mergeScenes } from '../../src/lib/server/scene-split-merge';
import { restoreStory, trashStory } from '../../src/lib/server/story-lifecycle';
import { rebuildSceneMentions, reconcileMentions } from '../../src/lib/server/mentions';
import { setSceneStatus } from '../../src/lib/server/scene-status';
import { applySceneOrder } from '../../src/lib/server/scene-order';
import { saveSceneBody } from '../../src/lib/server/scene-save';
import { restoreUniverse, trashUniverse } from '../../src/lib/server/universe-lifecycle';

// Storing the account API key encrypts it with APP_SECRET.
process.env.APP_SECRET = process.env.APP_SECRET || 'character-arc-test-secret';

const { summariseCharacterArc, arcIsStale, planArc, ArcStoryMutedError } =
	await import('../../src/lib/server/llm/arc-summary');
const { saveAccountLlmConfig, saveStoryLlmOverride } =
	await import('../../src/lib/server/llm/config');
const { summariseStory } = await import('../../src/lib/server/llm/summaries');

let lastPrompt = '';
let calls = 0;
let reply = 'Bram leaves the harbour and becomes a captain.';
// Set to 'length' to have the stub report a reply cut off at the cap.
let finish: 'length' | undefined;
// Runs while the model is "writing", to change things under a running job.
let duringCall: (() => Promise<void>) | null = null;
const stubProvider: Provider = {
	async *chatStream() {
		yield { type: 'done' };
	},
	async respond(req) {
		lastPrompt = JSON.stringify(req.messages);
		calls += 1;
		if (duringCall) await duringCall();
		return { content: reply, toolCalls: [], finishReason: finish };
	},
	async listModels() {
		return [];
	}
};
const noHttp: HttpRequest = async () => {
	throw new Error('the injected provider should not call the transport');
};
const deps: GatewayDeps = { provider: stubProvider, http: noHttp };

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let strangerId: string;
let universeId: string;
let firstStoryId: string;
let secondStoryId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	calls = 0;
	finish = undefined;
	lastPrompt = '';
	duringCall = null;
	reply = 'Bram leaves the harbour and becomes a captain.';
	await pool.query(
		'truncate table entity_mentions, scenes, characters, stories, universes, users cascade'
	);
	const [owner] = await db
		.insert(users)
		.values({ email: 'o@example.com', displayName: 'Olwen', passwordHash: 'x', role: 'user' })
		.returning({ id: users.id });
	ownerId = owner.id;
	const [stranger] = await db
		.insert(users)
		.values({ email: 's@example.com', displayName: 'Sam', passwordHash: 'x', role: 'user' })
		.returning({ id: users.id });
	strangerId = stranger.id;
	const [universe] = await db
		.insert(universes)
		.values({ ownerId, name: 'Aldermoor' })
		.returning({ id: universes.id });
	universeId = universe.id;
	const [first] = await db
		.insert(stories)
		.values({ universeId, ownerId, title: 'The Tide Below', positionInSeries: 1 })
		.returning({ id: stories.id });
	firstStoryId = first.id;
	const [second] = await db
		.insert(stories)
		.values({ universeId, ownerId, title: 'The Salt Road', positionInSeries: 2 })
		.returning({ id: stories.id });
	secondStoryId = second.id;
	await saveAccountLlmConfig(db, ownerId, {
		enabled: true,
		assistantName: '',
		persona: 'balanced',
		endpoint: 'https://api.example.com/v1',
		apiKey: 'sk',
		models: { chat: 'chat-model' },
		toolCallBudget: 8
	});
});

afterAll(async () => {
	await pool.end();
});

async function makeCharacter() {
	const [c] = await db
		.insert(characters)
		.values({ universeId, ownerId, name: 'Bram', summaryMd: 'A sailor.' })
		.returning({ id: characters.id, updatedAt: characters.updatedAt });
	return c;
}

async function sceneMentioning(
	storyId: string,
	characterId: string,
	opts: { position: number; summaryMd?: string; snippet: string }
) {
	const [scene] = await db
		.insert(scenes)
		.values({ storyId, globalPosition: opts.position, summaryMd: opts.summaryMd ?? null })
		.returning({ id: scenes.id });
	await db.insert(entityMentions).values({
		sourceType: 'scene',
		sourceId: scene.id,
		targetType: 'character',
		targetId: characterId,
		position: 0,
		surroundingText: opts.snippet
	});
	return scene.id;
}

async function readArc(id: string) {
	const [row] = await db
		.select({
			arcSummaryMd: characters.arcSummaryMd,
			arcSummaryAt: characters.arcSummaryAt,
			updatedAt: characters.updatedAt,
			summaryMd: characters.summaryMd
		})
		.from(characters)
		.where(eq(characters.id, id));
	return row;
}

describe('summariseCharacterArc', () => {
	it('writes the arc from every story in order, using summaries over passages', async () => {
		const bram = await makeCharacter();
		await sceneMentioning(secondStoryId, bram.id, { position: 1, snippet: 'Bram takes the helm' });
		await sceneMentioning(firstStoryId, bram.id, {
			position: 1,
			summaryMd: 'Bram leaves home.',
			snippet: 'Bram at the quay'
		});

		const result = await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		expect(result.outcome).toBe('written');
		expect(lastPrompt.indexOf('Bram leaves home.')).toBeGreaterThan(-1);
		expect(lastPrompt).not.toContain('Bram at the quay');
		expect(lastPrompt.indexOf('Bram leaves home.')).toBeLessThan(
			lastPrompt.indexOf('Bram takes the helm')
		);

		const row = await readArc(bram.id);
		expect(row.arcSummaryMd).toBe('Bram leaves the harbour and becomes a captain.');
		expect(row.arcSummaryAt).not.toBeNull();
		// Generated metadata: not an edit, and the writer's summary is untouched.
		expect(row.updatedAt.getTime()).toBe(bram.updatedAt.getTime());
		expect(row.summaryMd).toBe('A sailor.');
	});

	it('leaves out a story the Assistant is muted on', async () => {
		const bram = await makeCharacter();
		await sceneMentioning(firstStoryId, bram.id, { position: 1, snippet: 'Bram at the quay' });
		await sceneMentioning(secondStoryId, bram.id, { position: 1, snippet: 'Bram in private' });
		await saveStoryLlmOverride(db, secondStoryId, { enabled: false });
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		expect(lastPrompt).toContain('Bram at the quay');
		expect(lastPrompt).not.toContain('Bram in private');
		expect(lastPrompt).not.toContain('The Salt Road');
	});

	it('drops an arc when its story is muted, and when nothing is left to retell', async () => {
		const bram = await makeCharacter();
		await sceneMentioning(secondStoryId, bram.id, { position: 1, snippet: 'Bram in private' });
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		expect((await readArc(bram.id)).arcSummaryMd).not.toBeNull();

		await saveStoryLlmOverride(db, secondStoryId, { enabled: false });
		expect((await readArc(bram.id)).arcSummaryMd).toBeNull();

		await db
			.update(characters)
			.set({ arcSummaryMd: 'Old arc.', arcSummaryAt: new Date() })
			.where(eq(characters.id, bram.id));
		const result = await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		expect(result.outcome).toBe('empty');
		expect((await readArc(bram.id)).arcSummaryMd).toBeNull();
	});

	it('does not store an arc when a story it read is muted while it is written', async () => {
		const bram = await makeCharacter();
		await sceneMentioning(firstStoryId, bram.id, { position: 1, snippet: 'Bram at the quay' });
		await sceneMentioning(secondStoryId, bram.id, { position: 1, snippet: 'Bram in private' });
		duringCall = () => saveStoryLlmOverride(db, secondStoryId, { enabled: false });
		await expect(
			summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps)
		).rejects.toThrow(ArcStoryMutedError);
		expect((await readArc(bram.id)).arcSummaryMd).toBeNull();
	});

	it('keeps an out-of-date mark set while the arc was being rewritten', async () => {
		const bram = await makeCharacter();
		await sceneMentioning(firstStoryId, bram.id, { position: 1, snippet: 'Bram at the quay' });
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		// An unmute or a scene delete lands while the model writes the new arc.
		duringCall = async () => {
			await pool.query(
				`update characters set arc_summary_at = now() - interval '50 years' where id = $1`,
				[bram.id]
			);
		};
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		const [after] = await db.select().from(characters).where(eq(characters.id, bram.id));
		expect(after.arcSummaryAt! < STALE_MARK_BEFORE).toBe(true);
		expect(arcIsStale(after)).toBe(true);
	});

	it('keeps a second mark that lands while an out-of-date arc is refreshed', async () => {
		const bram = await makeCharacter();
		const sceneId = await sceneMentioning(firstStoryId, bram.id, {
			position: 1,
			snippet: 'Bram at the quay'
		});
		await sceneMentioning(secondStoryId, bram.id, { position: 1, snippet: 'Bram in private' });
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		await trashStory(db, ownerId, secondStoryId);
		// Refreshing the marked arc; the story comes back while the model writes.
		duringCall = async () => {
			await restoreStory(db, ownerId, secondStoryId);
		};
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		const [after] = await db.select().from(characters).where(eq(characters.id, bram.id));
		expect(arcIsStale(after)).toBe(true);
		expect(sceneId).toBeTruthy();
	});

	it('keeps a mark that lands in the same millisecond as the one it started from', async () => {
		const bram = await makeCharacter();
		await sceneMentioning(firstStoryId, bram.id, { position: 1, snippet: 'Bram at the quay' });
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		// A changed passage, so the refresh asks the model.
		await db.update(entityMentions).set({ surroundingText: 'Bram on the road' });
		await pool.query(
			`update characters set arc_summary_at = '1976-01-01 00:00:00.123456+00' where id = $1`,
			[bram.id]
		);
		duringCall = async () => {
			await pool.query(
				`update characters set arc_summary_at = '1976-01-01 00:00:00.123999+00' where id = $1`,
				[bram.id]
			);
		};
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		expect(arcIsStale(await readArc(bram.id))).toBe(true);
	});

	it('asks nothing for a character no scene mentions', async () => {
		const bram = await makeCharacter();
		const result = await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		expect(result.outcome).toBe('empty');
		expect(calls).toBe(0);
	});

	it("leaves another writer's character alone", async () => {
		const bram = await makeCharacter();
		await sceneMentioning(firstStoryId, bram.id, { position: 1, snippet: 'Bram' });
		const result = await summariseCharacterArc(
			db,
			{ userId: strangerId, characterId: bram.id },
			deps
		);
		expect(result.outcome).toBe('missing');
		expect(calls).toBe(0);
		expect((await readArc(bram.id)).arcSummaryMd).toBeNull();
	});

	it('keeps the earlier arc when the Assistant returns nothing', async () => {
		const bram = await makeCharacter();
		await sceneMentioning(firstStoryId, bram.id, { position: 1, snippet: 'Bram' });
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		reply = '   ';
		await expect(
			summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps)
		).rejects.toThrow();
		expect((await readArc(bram.id)).arcSummaryMd).toBe(
			'Bram leaves the harbour and becomes a captain.'
		);
	});

	it('keeps the earlier arc when the reply is cut off at the cap', async () => {
		const bram = await makeCharacter();
		await sceneMentioning(firstStoryId, bram.id, { position: 1, snippet: 'Bram' });
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		reply = 'Bram leaves the harbour and';
		finish = 'length';
		await expect(
			summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps)
		).rejects.toThrow(/cut off/);
		expect((await readArc(bram.id)).arcSummaryMd).toBe(
			'Bram leaves the harbour and becomes a captain.'
		);
	});
});

describe('arc staleness', () => {
	// A scene indexed the way the worker does it, so the marks it sets are real.
	async function sceneWithProse(bodyMd: string, storyId = firstStoryId) {
		const [scene] = await db
			.insert(scenes)
			.values({ storyId, globalPosition: 1, bodyMd })
			.returning({ id: scenes.id });
		await rebuildSceneMentions(db, scene.id);
		return scene.id;
	}

	async function readCharacter(id: string) {
		const [row] = await db.select().from(characters).where(eq(characters.id, id));
		return row;
	}

	it('goes stale when the prose around a mention changes after the arc was written', async () => {
		const bram = await makeCharacter();
		const sceneId = await sceneWithProse('Bram at the harbour.');
		expect(planArc({ kind: 'character', entity: await readCharacter(bram.id) })).toEqual({
			summaryMd: null,
			stale: false
		});

		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		const written = await readCharacter(bram.id);
		expect(arcIsStale(written)).toBe(false);
		expect(planArc({ kind: 'place', entity: written })).toBeNull();

		await db.update(scenes).set({ bodyMd: 'Bram on the quay.' }).where(eq(scenes.id, sceneId));
		await rebuildSceneMentions(db, sceneId);
		expect(arcIsStale(await readCharacter(bram.id))).toBe(true);
	});

	it('stays current through a status change on a mentioning scene', async () => {
		const bram = await makeCharacter();
		const sceneId = await sceneWithProse('Bram at the harbour.');
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		expect(await setSceneStatus(db, ownerId, sceneId, 'final')).toBe(true);
		expect(await reconcileMentions(db)).toBe(1);
		expect(arcIsStale(await readCharacter(bram.id))).toBe(false);
	});

	it('stays current through an edit in a story the Assistant is muted on', async () => {
		const bram = await makeCharacter();
		await sceneWithProse('Bram at the harbour.');
		const privateId = await sceneWithProse('Bram in private.', secondStoryId);
		await saveStoryLlmOverride(db, secondStoryId, { enabled: false });
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		await db.update(scenes).set({ bodyMd: 'Bram alone.' }).where(eq(scenes.id, privateId));
		await rebuildSceneMentions(db, privateId);
		expect(arcIsStale(await readCharacter(bram.id))).toBe(false);
	});

	it('goes stale, without an enrich mark, when mentioning scenes change order', async () => {
		const bram = await makeCharacter();
		const first = await sceneWithProse('Bram at the harbour.');
		const [second] = await db
			.insert(scenes)
			.values({ storyId: firstStoryId, globalPosition: 2, bodyMd: 'Bram on the road.' })
			.returning({ id: scenes.id });
		await rebuildSceneMentions(db, second.id);
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		const enrichedAt = new Date('2026-01-01T00:00:00Z');
		await db
			.update(characters)
			.set({ assistantEnrichedAt: enrichedAt })
			.where(eq(characters.id, bram.id));

		// The same order again moves nothing.
		const same = { chapters: [], orphanSceneIds: [first, second.id] };
		expect((await applySceneOrder(db, firstStoryId, same)).ok).toBe(true);
		expect(arcIsStale(await readCharacter(bram.id))).toBe(false);

		const swapped = { chapters: [], orphanSceneIds: [second.id, first] };
		expect((await applySceneOrder(db, firstStoryId, swapped)).ok).toBe(true);
		const after = await readCharacter(bram.id);
		expect(arcIsStale(after)).toBe(true);
		expect(after.assistantEnrichedAt).toEqual(enrichedAt);
	});

	it('goes stale, without an enrich mark, when a mentioning scene is renamed', async () => {
		const bram = await makeCharacter();
		const sceneId = await sceneWithProse('Bram at the harbour.');
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		const enrichedAt = new Date('2026-01-01T00:00:00Z');
		await db
			.update(characters)
			.set({ assistantEnrichedAt: enrichedAt })
			.where(eq(characters.id, bram.id));
		const save = {
			bodyMd: 'Bram at the harbour.',
			anchors: null,
			baseHashes: null,
			overwrite: false
		};

		expect((await saveSceneBody(db, sceneId, { ...save, title: null })).ok).toBe(true);
		expect(arcIsStale(await readCharacter(bram.id))).toBe(false);
		expect((await saveSceneBody(db, sceneId, { ...save, title: 'Low tide' })).ok).toBe(true);
		const after = await readCharacter(bram.id);
		expect(arcIsStale(after)).toBe(true);
		expect(after.assistantEnrichedAt).toEqual(enrichedAt);
	});

	it('goes stale, and is marked for enrichment, when its universe is restored', async () => {
		const bram = await makeCharacter();
		await sceneWithProse('Bram at the harbour.');
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		expect(await trashUniverse(db, ownerId, universeId)).toBe(true);
		expect(await restoreUniverse(db, ownerId, universeId)).toBe(true);
		const after = await readCharacter(bram.id);
		expect(arcIsStale(after)).toBe(true);
		expect(after.assistantEnrichedAt! < STALE_MARK_BEFORE).toBe(true);
	});

	it('goes stale when a new scene summary is written for a mentioning scene', async () => {
		const bram = await makeCharacter();
		await sceneWithProse('Bram at the harbour.');
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		expect(
			(await summariseStory(db, { userId: ownerId, storyId: firstStoryId }, deps)).scenes
		).toBe(1);
		expect(arcIsStale(await readCharacter(bram.id))).toBe(true);
	});

	it('goes stale when a mentioning scene is deleted', async () => {
		const bram = await makeCharacter();
		const sceneId = await sceneMentioning(firstStoryId, bram.id, { position: 1, snippet: 'Bram' });
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		const [written] = await db.select().from(characters).where(eq(characters.id, bram.id));
		expect(arcIsStale(written)).toBe(false);
		expect(await trashScene(db, ownerId, sceneId)).toBe(true);
		const [after] = await db.select().from(characters).where(eq(characters.id, bram.id));
		expect(arcIsStale(after)).toBe(true);
	});

	it('goes stale when a mentioning scene is merged into another', async () => {
		const bram = await makeCharacter();
		const [target] = await db
			.insert(scenes)
			.values({ storyId: firstStoryId, globalPosition: 1 })
			.returning({ id: scenes.id });
		const merged = await sceneMentioning(firstStoryId, bram.id, { position: 2, snippet: 'Bram' });
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		const result = await mergeScenes(db, ownerId, firstStoryId, [target.id, merged]);
		expect(result.ok).toBe(true);
		expect((await readArc(bram.id)).arcSummaryAt! < STALE_MARK_BEFORE).toBe(true);
	});

	it('goes stale, and is marked for enrichment, when a deleted scene is restored and reindexed', async () => {
		const bram = await makeCharacter();
		const sceneId = await sceneWithProse('Bram at the harbour.');
		const [kept] = await db
			.insert(scenes)
			.values({ storyId: firstStoryId, globalPosition: 2, bodyMd: 'Bram on the road.' })
			.returning({ id: scenes.id });
		await rebuildSceneMentions(db, kept.id);
		expect(await trashScene(db, ownerId, sceneId)).toBe(true);
		// Rewritten without the deleted scene, then the scene comes back.
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		await db
			.update(characters)
			.set({ assistantEnrichedAt: new Date() })
			.where(eq(characters.id, bram.id));
		expect(arcIsStale(await readCharacter(bram.id))).toBe(false);

		expect(await restoreScene(db, ownerId, sceneId)).toBe(true);
		await rebuildSceneMentions(db, sceneId);
		const after = await readCharacter(bram.id);
		expect(arcIsStale(after)).toBe(true);
		expect(after.assistantEnrichedAt! < STALE_MARK_BEFORE).toBe(true);
	});

	it('goes stale, and is marked for enrichment, when a trashed standalone home is revived', async () => {
		const home = await standaloneUniverse(db, ownerId);
		const [story] = await db
			.insert(stories)
			.values({ universeId: home.id, ownerId, title: 'A One-Off' })
			.returning({ id: stories.id });
		const [bram] = await db
			.insert(characters)
			.values({ universeId: home.id, ownerId, name: 'Bram' })
			.returning({ id: characters.id });
		await sceneMentioning(story.id, bram.id, { position: 1, snippet: 'Bram at the quay' });
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		await db
			.update(characters)
			.set({ assistantEnrichedAt: new Date() })
			.where(eq(characters.id, bram.id));
		await db.update(universes).set({ deletedAt: new Date() }).where(eq(universes.id, home.id));

		// Asking for the standalone home again brings it back.
		expect((await standaloneUniverse(db, ownerId)).deletedAt).toBeNull();
		const after = await readCharacter(bram.id);
		expect(arcIsStale(after)).toBe(true);
		expect(after.assistantEnrichedAt! < STALE_MARK_BEFORE).toBe(true);
	});

	it('stays current when a reorder after a deletion keeps the reading order', async () => {
		const bram = await makeCharacter();
		const ids: string[] = [];
		for (const [i, bodyMd] of [
			'An empty quay.',
			'Nobody here.',
			'Bram at the harbour.'
		].entries()) {
			const [scene] = await db
				.insert(scenes)
				.values({ storyId: firstStoryId, globalPosition: i + 1, bodyMd })
				.returning({ id: scenes.id });
			await rebuildSceneMentions(db, scene.id);
			ids.push(scene.id);
		}
		const [first, gap, last] = ids;
		expect(await trashScene(db, ownerId, gap)).toBe(true);
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);

		// Renumbering closes the gap, but Bram's scene still comes second.
		const order = { chapters: [], orphanSceneIds: [first, last] };
		expect((await applySceneOrder(db, firstStoryId, order)).ok).toBe(true);
		expect(arcIsStale(await readCharacter(bram.id))).toBe(false);

		const swapped = { chapters: [], orphanSceneIds: [last, first] };
		expect((await applySceneOrder(db, firstStoryId, swapped)).ok).toBe(true);
		expect(arcIsStale(await readCharacter(bram.id))).toBe(true);
	});

	it('refreshes an out-of-date arc without the model when nothing it reads changed', async () => {
		const bram = await makeCharacter();
		const filler = ' The tide ran out over the flats.'.repeat(6);
		const sceneId = await sceneWithProse(`Bram at the harbour.${filler} Bram waved.`);
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		expect(calls).toBe(1);

		// The arc reads the passage around the first mention only, so an edit at
		// the second marks it without changing what it would send.
		await db
			.update(scenes)
			.set({ bodyMd: `Bram at the harbour.${filler} Bram waved twice.` })
			.where(eq(scenes.id, sceneId));
		await rebuildSceneMentions(db, sceneId);
		expect(arcIsStale(await readCharacter(bram.id))).toBe(true);
		reply = 'A different arc.';
		const result = await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		expect(result.outcome).toBe('unchanged');
		expect(calls).toBe(1);
		const after = await readCharacter(bram.id);
		expect(arcIsStale(after)).toBe(false);
		expect(after.arcSummaryMd).toBe('Bram leaves the harbour and becomes a captain.');

		// An edit it does read is sent.
		await db
			.update(scenes)
			.set({ bodyMd: `Bram on the quay.${filler} Bram waved twice.` })
			.where(eq(scenes.id, sceneId));
		await rebuildSceneMentions(db, sceneId);
		expect(
			(await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps)).outcome
		).toBe('written');
		expect(calls).toBe(2);
		expect((await readCharacter(bram.id)).arcSummaryMd).toBe('A different arc.');
	});

	it('does not call an arc up to date when a mark lands while it is checked', async () => {
		const bram = await makeCharacter();
		const filler = ' The tide ran out over the flats.'.repeat(6);
		const sceneId = await sceneWithProse(`Bram at the harbour.${filler} Bram waved.`);
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		await db
			.update(scenes)
			.set({ bodyMd: `Bram at the harbour.${filler} Bram waved twice.` })
			.where(eq(scenes.id, sceneId));
		await rebuildSceneMentions(db, sceneId);

		// Another save marks the arc and holds its row, so the check reads the
		// earlier mark and then waits on the row until the save commits.
		const save = await pool.connect();
		try {
			await save.query('begin');
			await save.query(
				`update characters set arc_summary_at = clock_timestamp() - interval '50 years' where id = $1`,
				[bram.id]
			);
			const check = summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
			for (let i = 0; i < 100; i++) {
				const { rows } = await pool.query(
					`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`
				);
				if (rows[0].n > 0) break;
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			await save.query('commit');
			expect((await check).outcome).toBe('changed');
		} finally {
			save.release(true);
		}
		expect(calls).toBe(1);
		expect(arcIsStale(await readCharacter(bram.id))).toBe(true);
	});

	it('rewrites a current arc when asked, even with nothing changed', async () => {
		const bram = await makeCharacter();
		await sceneWithProse('Bram at the harbour.');
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		reply = 'A different arc.';
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		expect(calls).toBe(2);
		expect((await readCharacter(bram.id)).arcSummaryMd).toBe('A different arc.');
	});

	it('does not deadlock with a save that holds the scene row and then marks entities', async () => {
		const bram = await makeCharacter();
		const sceneId = await sceneWithProse('Bram at the harbour.');
		await db.update(scenes).set({ bodyMd: 'Bram on the quay.' }).where(eq(scenes.id, sceneId));
		// A title save takes the scene row first, as saveSceneBody does.
		const save = await pool.connect();
		try {
			await save.query('begin');
			await save.query('select id from scenes where id = $1 for update', [sceneId]);
			const rebuild = rebuildSceneMentions(db, sceneId).catch((err: unknown) => err);
			await new Promise((resolve) => setTimeout(resolve, 200));
			// Then marks what the scene mentions.
			await save.query(
				`update characters set arc_summary_at = clock_timestamp() - interval '50 years' where id = $1`,
				[bram.id]
			);
			await save.query('commit');
			expect(await rebuild).toEqual({ ok: true, count: 1 });
		} finally {
			// Dropped rather than pooled, in case a failure left it mid-transaction.
			save.release(true);
		}
	});

	it('goes stale when a story it read is deleted, and again when it is restored', async () => {
		const bram = await makeCharacter();
		await sceneMentioning(firstStoryId, bram.id, { position: 1, snippet: 'Bram' });
		await sceneMentioning(secondStoryId, bram.id, { position: 1, snippet: 'Bram again' });
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		expect(await trashStory(db, ownerId, secondStoryId)).toBe(true);
		const [trashed] = await db.select().from(characters).where(eq(characters.id, bram.id));
		expect(arcIsStale(trashed)).toBe(true);
		// Rewritten without the deleted story, then the story comes back.
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		const [rewritten] = await db.select().from(characters).where(eq(characters.id, bram.id));
		expect(arcIsStale(rewritten)).toBe(false);
		expect(await restoreStory(db, ownerId, secondStoryId)).toBe(true);
		const [restored] = await db.select().from(characters).where(eq(characters.id, bram.id));
		expect(arcIsStale(restored)).toBe(true);
		expect(restored.assistantEnrichedAt! < STALE_MARK_BEFORE).toBe(true);
	});
});

describe('a restore that cannot mark what it brings back', () => {
	// Any update to characters fails, the way a dropped connection would fail the
	// mark after the row was revived.
	async function withFailingMark(run: () => Promise<unknown>) {
		await pool.query(`create or replace function arc_test_fail() returns trigger as $$
			begin raise exception 'mark failed'; end $$ language plpgsql`);
		await pool.query(
			'create trigger arc_test_fail before update on characters for each statement execute function arc_test_fail()'
		);
		try {
			await expect(run()).rejects.toThrow();
		} finally {
			await pool.query('drop trigger arc_test_fail on characters');
			await pool.query('drop function arc_test_fail()');
		}
	}

	it('leaves a story in the trash', async () => {
		const bram = await makeCharacter();
		await sceneMentioning(secondStoryId, bram.id, { position: 1, snippet: 'Bram' });
		expect(await trashStory(db, ownerId, secondStoryId)).toBe(true);
		await withFailingMark(() => restoreStory(db, ownerId, secondStoryId));
		const [story] = await db.select().from(stories).where(eq(stories.id, secondStoryId));
		expect(story.deletedAt).not.toBeNull();
	});

	it('leaves a universe in the trash', async () => {
		const bram = await makeCharacter();
		await sceneMentioning(firstStoryId, bram.id, { position: 1, snippet: 'Bram' });
		expect(await trashUniverse(db, ownerId, universeId)).toBe(true);
		await withFailingMark(() => restoreUniverse(db, ownerId, universeId));
		const [universe] = await db.select().from(universes).where(eq(universes.id, universeId));
		expect(universe.deletedAt).not.toBeNull();
	});
});

describe('muting and unmuting a story', () => {
	it('drops every arc in the universe on a mute, even one whose mention was edited away', async () => {
		const bram = await makeCharacter();
		const other = await makeCharacter();
		const sceneId = await sceneMentioning(secondStoryId, bram.id, {
			position: 1,
			snippet: 'Bram in private'
		});
		await sceneMentioning(firstStoryId, other.id, { position: 1, snippet: 'Bram elsewhere' });
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		await summariseCharacterArc(db, { userId: ownerId, characterId: other.id }, deps);
		await db.delete(entityMentions).where(eq(entityMentions.sourceId, sceneId));

		await saveStoryLlmOverride(db, secondStoryId, { enabled: false });
		expect((await readArc(bram.id)).arcSummaryMd).toBeNull();
		expect((await readArc(other.id)).arcSummaryMd).toBeNull();
	});

	it('marks an arc written while the story was muted, even one started with none', async () => {
		const bram = await makeCharacter();
		await sceneMentioning(firstStoryId, bram.id, { position: 1, snippet: 'Bram' });
		await sceneMentioning(secondStoryId, bram.id, { position: 1, snippet: 'Bram in private' });
		await saveStoryLlmOverride(db, secondStoryId, { enabled: false });
		// The mute cleared every arc; the story is unmuted while the arc is written.
		duringCall = () => saveStoryLlmOverride(db, secondStoryId, { enabled: null });
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		const [after] = await db.select().from(characters).where(eq(characters.id, bram.id));
		expect(after.arcSummaryMd).not.toBeNull();
		expect(arcIsStale(after)).toBe(true);
	});

	it('keeps arcs written after a mute when the story is muted again', async () => {
		const bram = await makeCharacter();
		await sceneMentioning(firstStoryId, bram.id, { position: 1, snippet: 'Bram' });
		await saveStoryLlmOverride(db, secondStoryId, { enabled: false });
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		await saveStoryLlmOverride(db, secondStoryId, { enabled: false });
		expect((await readArc(bram.id)).arcSummaryMd).not.toBeNull();
	});

	it('marks arcs out of date and entities for another enrich pass on an unmute', async () => {
		const bram = await makeCharacter();
		await sceneMentioning(firstStoryId, bram.id, { position: 1, snippet: 'Bram' });
		await saveStoryLlmOverride(db, secondStoryId, { enabled: false });
		await sceneMentioning(secondStoryId, bram.id, { position: 1, snippet: 'Bram in private' });
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		await db
			.update(characters)
			.set({ assistantEnrichedAt: new Date() })
			.where(eq(characters.id, bram.id));
		const [before] = await db.select().from(characters).where(eq(characters.id, bram.id));
		expect(arcIsStale(before)).toBe(false);

		await saveStoryLlmOverride(db, secondStoryId, { enabled: null });
		const [after] = await db.select().from(characters).where(eq(characters.id, bram.id));
		expect(after.arcSummaryMd).toBe(before.arcSummaryMd);
		expect(arcIsStale(after)).toBe(true);
		expect(after.assistantEnrichedAt! < STALE_MARK_BEFORE).toBe(true);
	});
});
