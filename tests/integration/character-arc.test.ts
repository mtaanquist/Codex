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
import type { ChatMessage, HttpRequest, Provider } from '../../src/lib/server/llm/providers/types';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';
import { restoreScene, trashScene } from '../../src/lib/server/scene-lifecycle';
import { standaloneUniverse } from '../../src/lib/server/story-create';
import { mergeScenes } from '../../src/lib/server/scene-split-merge';
import { restoreStory, trashStory } from '../../src/lib/server/story-lifecycle';
import { rebuildSceneMentions, reconcileMentions } from '../../src/lib/server/mentions';
import { setSceneStatus } from '../../src/lib/server/scene-status';
import { applySceneOrder } from '../../src/lib/server/scene-order';
import { saveSceneBody } from '../../src/lib/server/scene-save';
import { restoreUniverse, trashUniverse } from '../../src/lib/server/universe-lifecycle';
import { saveStoryDetails } from '../../src/lib/server/story-details';
import { saveEntity } from '../../src/lib/server/entity-save';
import { purgeStory } from '../../src/lib/server/story-delete';
import { arcRequests } from '../../src/lib/server/llm/arc-request';
import { buildArcMessage } from '../../src/lib/server/llm/prompts/arc';
import { requestHash } from '../../src/lib/server/llm/request-hash';

// Storing the account API key encrypts it with APP_SECRET.
process.env.APP_SECRET = process.env.APP_SECRET || 'character-arc-test-secret';

const { summariseCharacterArc, planArc } = await import('../../src/lib/server/llm/arc-summary');
const { saveAccountLlmConfig, saveModelPricing, saveStoryLlmOverride, saveUniverseModels } =
	await import('../../src/lib/server/llm/config');
const { summariseStory } = await import('../../src/lib/server/llm/summaries');
const { assembleContext } = await import('../../src/lib/server/llm/context/assemble');

let lastPrompt = '';
let lastModel = '';
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
		lastModel = req.model;
		calls += 1;
		if (duringCall) await duringCall();
		return {
			content: reply,
			toolCalls: [],
			finishReason: finish,
			usage: { promptTokens: 1000, completionTokens: 0 }
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
		'truncate table assistant_job_spend, entity_mentions, scenes, characters, stories, universes, users cascade'
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

// Whether the character's arc reads as out of date, as the Plan page shows it.
async function arcStale(id: string): Promise<boolean> {
	const [entity] = await db.select().from(characters).where(eq(characters.id, id));
	return (await planArc(db, { kind: 'character', entity }))!.stale;
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

	it('builds each request from the first mention per scene, in reading order', async () => {
		const bram = await makeCharacter();
		const [isolde] = await db
			.insert(characters)
			.values({ universeId, ownerId, name: 'Isolde' })
			.returning({ id: characters.id });
		const later = await sceneMentioning(secondStoryId, bram.id, {
			position: 1,
			snippet: 'Bram takes the helm'
		});
		const second = await sceneMentioning(firstStoryId, bram.id, {
			position: 2,
			snippet: 'Bram on the road'
		});
		const first = await sceneMentioning(firstStoryId, bram.id, {
			position: 1,
			summaryMd: 'Bram leaves home.',
			snippet: 'Bram at the quay'
		});
		// Later mentions in the same scenes, and another character in two of them.
		const more = (sourceId: string, targetId: string, position: number, text: string) => ({
			sourceType: 'scene',
			sourceId,
			targetType: 'character' as const,
			targetId,
			position,
			surroundingText: text
		});
		await db
			.insert(entityMentions)
			.values([
				more(second, bram.id, 40, 'Bram rests'),
				more(second, bram.id, 90, 'Bram sleeps'),
				more(later, bram.id, 12, 'Bram shouts'),
				more(second, isolde.id, 50, 'Isolde waves'),
				more(second, isolde.id, 5, 'Isolde waits'),
				more(first, isolde.id, 70, 'Isolde nods')
			]);

		const requests = await arcRequests(db, universeId, [
			{ id: bram.id, name: 'Bram' },
			{ id: isolde.id, name: 'Isolde' }
		]);
		const expected = (name: string, arcScenes: [string, string][]) => [
			{
				role: 'user',
				content: buildArcMessage(
					name,
					arcScenes.map(([storyTitle, text]) => ({ storyTitle, sceneTitle: null, text }))
				)
			}
		];
		const bramMessages = expected('Bram', [
			['The Tide Below', 'Bram leaves home.'],
			['The Tide Below', 'Bram on the road'],
			['The Salt Road', 'Bram takes the helm']
		]);
		expect(requests.get(bram.id)).toEqual({
			messages: bramMessages,
			input: requestHash(bramMessages as ChatMessage[]),
			storyIds: [firstStoryId, secondStoryId]
		});
		expect(requests.get(isolde.id)!.storyIds).toEqual([firstStoryId]);
		// A scene with a summary is told by it, whichever mention came first.
		expect(requests.get(isolde.id)!.messages).toEqual(
			expected('Isolde', [
				['The Tide Below', 'Bram leaves home.'],
				['The Tide Below', 'Isolde waits']
			])
		);
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

	it('shows an arc as out of date when its story is muted, and drops it when nothing is left to retell', async () => {
		const bram = await makeCharacter();
		await sceneMentioning(secondStoryId, bram.id, { position: 1, snippet: 'Bram in private' });
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		expect(await arcStale(bram.id)).toBe(false);

		// The mute itself writes nothing to the character.
		await saveStoryLlmOverride(db, secondStoryId, { enabled: false });
		expect((await readArc(bram.id)).arcSummaryMd).not.toBeNull();
		expect(await arcStale(bram.id)).toBe(true);

		const result = await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		expect(result.outcome).toBe('empty');
		expect((await readArc(bram.id)).arcSummaryMd).toBeNull();
	});

	it('stores an arc as out of date when a story it read is muted while it is written', async () => {
		const bram = await makeCharacter();
		await sceneMentioning(firstStoryId, bram.id, { position: 1, snippet: 'Bram at the quay' });
		await sceneMentioning(secondStoryId, bram.id, { position: 1, snippet: 'Bram in private' });
		duringCall = () => saveStoryLlmOverride(db, secondStoryId, { enabled: false });
		const result = await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		expect(result.outcome).toBe('written');
		expect(await arcStale(bram.id)).toBe(true);
	});

	it('stores an arc as out of date when a passage it read changes while it is written', async () => {
		const bram = await makeCharacter();
		await sceneMentioning(firstStoryId, bram.id, { position: 1, snippet: 'Bram at the quay' });
		duringCall = async () => {
			await db.update(entityMentions).set({ surroundingText: 'Bram on the road' });
		};
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		expect(await arcStale(bram.id)).toBe(true);
		// Written again from the passage as it now is.
		duringCall = null;
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		expect(lastPrompt).toContain('Bram on the road');
		expect(await arcStale(bram.id)).toBe(false);
	});

	it('stores an arc as out of date when a story comes back while it is written', async () => {
		const bram = await makeCharacter();
		await sceneMentioning(firstStoryId, bram.id, { position: 1, snippet: 'Bram at the quay' });
		await sceneMentioning(secondStoryId, bram.id, { position: 1, snippet: 'Bram in private' });
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		await trashStory(db, ownerId, secondStoryId);
		duringCall = async () => {
			await restoreStory(db, ownerId, secondStoryId);
		};
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		expect(await arcStale(bram.id)).toBe(true);
	});

	it('reads an arc stored without a fingerprint as out of date', async () => {
		const bram = await makeCharacter();
		await sceneMentioning(firstStoryId, bram.id, { position: 1, snippet: 'Bram at the quay' });
		// As an earlier release left it: a time, or a mark fifty years back.
		for (const at of [new Date(), new Date('1976-11-20T00:00:00Z')]) {
			await db
				.update(characters)
				.set({ arcSummaryMd: 'Old arc.', arcSummaryAt: at, arcSummaryInput: null })
				.where(eq(characters.id, bram.id));
			expect(await arcStale(bram.id)).toBe(true);
		}
	});

	it('reads an arc as current by its fingerprint, whatever its time says', async () => {
		const bram = await makeCharacter();
		await sceneMentioning(firstStoryId, bram.id, { position: 1, snippet: 'Bram at the quay' });
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		// A mark an earlier release set for a change the arc does not read.
		await pool.query(
			`update characters set arc_summary_at = now() - interval '50 years' where id = $1`,
			[bram.id]
		);
		expect(await arcStale(bram.id)).toBe(false);
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

describe('the model an arc is written with (#1266)', () => {
	it('is the one chosen for the universe', async () => {
		const bram = await makeCharacter();
		await sceneMentioning(firstStoryId, bram.id, { position: 1, snippet: 'Bram at the quay' });
		await saveUniverseModels(db, universeId, { utility: 'universe-model' });
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		expect(lastModel).toBe('universe-model');
	});
});

describe('the arc job and the spend cap (#1105)', () => {
	async function capAt(spendCapUsd: number) {
		await saveAccountLlmConfig(db, ownerId, {
			enabled: true,
			assistantName: '',
			persona: 'balanced',
			endpoint: 'https://api.example.com/v1',
			apiKey: 'sk',
			models: { chat: 'chat-model' },
			toolCallBudget: 8,
			spendCapUsd
		});
		// $1 a request: 1000 prompt tokens at $0.001.
		await saveModelPricing(db, ownerId, { 'chat-model': { prompt: 0.001, completion: 0 } });
	}

	it('counts the request towards the job', async () => {
		await capAt(5);
		const bram = await makeCharacter();
		await sceneMentioning(firstStoryId, bram.id, { position: 1, snippet: 'Bram' });
		const result = await summariseCharacterArc(
			db,
			{ userId: ownerId, characterId: bram.id, jobId: 'arc-1' },
			deps
		);
		expect(result.outcome).toBe('written');
		const { rows } = await pool.query(
			`select spent_usd from assistant_job_spend where job_id = 'arc-1'`
		);
		expect(rows[0].spent_usd).toBeCloseTo(1, 6);
	});

	it('asks nothing when earlier attempts of the job spent the ceiling', async () => {
		await capAt(1);
		const bram = await makeCharacter();
		await sceneMentioning(firstStoryId, bram.id, { position: 1, snippet: 'Bram' });
		await pool.query(
			`insert into assistant_job_spend (job_id, user_id, spent_usd) values ('arc-2', $1, 1)`,
			[ownerId]
		);
		const result = await summariseCharacterArc(
			db,
			{ userId: ownerId, characterId: bram.id, jobId: 'arc-2' },
			deps
		);
		expect(result).toEqual({ outcome: 'capped', spentUsd: 1 });
		expect(calls).toBe(0);
		expect((await readArc(bram.id)).arcSummaryMd).toBeNull();
	});
});

describe('arc staleness', () => {
	// A scene indexed the way the worker does it, so the mention rows are real.
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
		expect(await planArc(db, { kind: 'character', entity: await readCharacter(bram.id) })).toEqual({
			summaryMd: null,
			stale: false
		});

		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		const written = await readCharacter(bram.id);
		expect(await arcStale(bram.id)).toBe(false);
		expect(await planArc(db, { kind: 'place', entity: written })).toBeNull();

		await db.update(scenes).set({ bodyMd: 'Bram on the quay.' }).where(eq(scenes.id, sceneId));
		await rebuildSceneMentions(db, sceneId);
		expect(await arcStale(bram.id)).toBe(true);
	});

	it('stays current through a status change on a mentioning scene', async () => {
		const bram = await makeCharacter();
		const sceneId = await sceneWithProse('Bram at the harbour.');
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		expect(await setSceneStatus(db, ownerId, sceneId, 'final')).toBe(true);
		// Mentions read only the body, so a status change leaves nothing to rebuild.
		expect(await reconcileMentions(db)).toBe(0);
		expect(await arcStale(bram.id)).toBe(false);
	});

	it('stays current through an edit in a story the Assistant is muted on', async () => {
		const bram = await makeCharacter();
		await sceneWithProse('Bram at the harbour.');
		const privateId = await sceneWithProse('Bram in private.', secondStoryId);
		await saveStoryLlmOverride(db, secondStoryId, { enabled: false });
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		await db.update(scenes).set({ bodyMd: 'Bram alone.' }).where(eq(scenes.id, privateId));
		await rebuildSceneMentions(db, privateId);
		expect(await arcStale(bram.id)).toBe(false);
	});

	it('goes stale when mentioning scenes change order', async () => {
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
		expect(await arcStale(bram.id)).toBe(false);

		const swapped = { chapters: [], orphanSceneIds: [second.id, first] };
		expect((await applySceneOrder(db, firstStoryId, swapped)).ok).toBe(true);
		const after = await readCharacter(bram.id);
		expect(await arcStale(bram.id)).toBe(true);
		expect(after.assistantEnrichedAt).toEqual(enrichedAt);
	});

	it('goes stale when a mentioning scene is renamed', async () => {
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
		expect(await arcStale(bram.id)).toBe(false);
		expect((await saveSceneBody(db, sceneId, { ...save, title: 'Low tide' })).ok).toBe(true);
		const after = await readCharacter(bram.id);
		expect(await arcStale(bram.id)).toBe(true);
		// The save itself writes nothing to the character.
		expect(after.assistantEnrichedAt).toEqual(enrichedAt);
	});

	it('stays current through a universe trash and restore that changed nothing', async () => {
		const bram = await makeCharacter();
		await sceneWithProse('Bram at the harbour.');
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		const enrichedAt = new Date('2026-01-01T00:00:00Z');
		await db
			.update(characters)
			.set({ assistantEnrichedAt: enrichedAt })
			.where(eq(characters.id, bram.id));
		expect(await trashUniverse(db, ownerId, universeId)).toBe(true);
		expect(await restoreUniverse(db, ownerId, universeId)).toBe(true);
		const after = await readCharacter(bram.id);
		expect(await arcStale(bram.id)).toBe(false);
		expect(after.assistantEnrichedAt).toEqual(enrichedAt);
	});

	it('goes stale when a passage changes while its universe is in the trash', async () => {
		const bram = await makeCharacter();
		const cass = await db
			.insert(characters)
			.values({ universeId, ownerId, name: 'Cass' })
			.returning({ id: characters.id })
			.then(([row]) => row);
		const sceneId = await sceneWithProse('Bram at the harbour.');
		await sceneWithProse('Cass on the road.');
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		await summariseCharacterArc(db, { userId: ownerId, characterId: cass.id }, deps);
		expect(await trashUniverse(db, ownerId, universeId)).toBe(true);
		await db.update(scenes).set({ bodyMd: 'Bram on the quay.' }).where(eq(scenes.id, sceneId));
		await rebuildSceneMentions(db, sceneId);
		expect(await restoreUniverse(db, ownerId, universeId)).toBe(true);
		expect(await arcStale(bram.id)).toBe(true);
		// Only what changed is marked.
		expect(await arcStale(cass.id)).toBe(false);
	});

	it('goes stale when a new scene summary is written for a mentioning scene', async () => {
		const bram = await makeCharacter();
		await sceneWithProse('Bram at the harbour.');
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		expect(
			(await summariseStory(db, { userId: ownerId, storyId: firstStoryId }, deps)).scenes
		).toBe(1);
		expect(await arcStale(bram.id)).toBe(true);
	});

	it('goes stale when a mentioning scene is deleted', async () => {
		const bram = await makeCharacter();
		const sceneId = await sceneMentioning(firstStoryId, bram.id, { position: 1, snippet: 'Bram' });
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		expect(await arcStale(bram.id)).toBe(false);
		expect(await trashScene(db, ownerId, sceneId)).toBe(true);
		expect(await arcStale(bram.id)).toBe(true);
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
		expect(await arcStale(bram.id)).toBe(true);
	});

	it('goes stale when a deleted scene is restored and reindexed', async () => {
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
		expect(await arcStale(bram.id)).toBe(false);

		expect(await restoreScene(db, ownerId, sceneId)).toBe(true);
		await rebuildSceneMentions(db, sceneId);
		expect(await arcStale(bram.id)).toBe(true);
	});

	it('stays current when a trashed standalone home is revived', async () => {
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
		await db.update(universes).set({ deletedAt: new Date() }).where(eq(universes.id, home.id));

		// Asking for the standalone home again brings it back, with nothing changed.
		expect((await standaloneUniverse(db, ownerId)).deletedAt).toBeNull();
		expect(await arcStale(bram.id)).toBe(false);
	});

	// Wider than a passage's window, so each passage quotes only the filler.
	const filler = ' The tide ran out over the flats. '.repeat(3);

	it('goes stale when two passages that mention the character swap places', async () => {
		const bram = await makeCharacter();
		const harbour = `${filler}Bram at the harbour.${filler}`;
		const road = `Bram on the road.${filler}`;
		const sceneId = await sceneWithProse(harbour + road);
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		await db
			.update(scenes)
			.set({ bodyMd: `${filler}Bram on the road.${filler}Bram at the harbour.${filler}` })
			.where(eq(scenes.id, sceneId));
		await rebuildSceneMentions(db, sceneId);
		// The same passages, but the arc reads the first one.
		expect(await arcStale(bram.id)).toBe(true);
	});

	it('stays current when text added above only shifts the passages', async () => {
		const bram = await makeCharacter();
		const sceneId = await sceneWithProse(`${filler}Bram at the harbour.`);
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		await db
			.update(scenes)
			.set({ bodyMd: `A new opening line.${filler}Bram at the harbour.` })
			.where(eq(scenes.id, sceneId));
		await rebuildSceneMentions(db, sceneId);
		expect(await arcStale(bram.id)).toBe(false);
	});

	it('goes stale only for a character whose own scenes change order', async () => {
		const bram = await makeCharacter();
		const [cass] = await db
			.insert(characters)
			.values({ universeId, ownerId, name: 'Cass' })
			.returning({ id: characters.id });
		const ids: string[] = [];
		for (const [i, bodyMd] of ['Bram at the harbour.', 'Cass waits.', 'Cass leaves.'].entries()) {
			const [scene] = await db
				.insert(scenes)
				.values({ storyId: firstStoryId, globalPosition: i + 1, bodyMd })
				.returning({ id: scenes.id });
			await rebuildSceneMentions(db, scene.id);
			ids.push(scene.id);
		}
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		await summariseCharacterArc(db, { userId: ownerId, characterId: cass.id }, deps);
		const [first, second, third] = ids;
		// Every rank shifts, but each character's scenes still read in the same order.
		const order = { chapters: [], orphanSceneIds: [second, third, first] };
		expect((await applySceneOrder(db, firstStoryId, order)).ok).toBe(true);
		expect(await arcStale(bram.id)).toBe(false);
		expect(await arcStale(cass.id)).toBe(false);

		const swapped = { chapters: [], orphanSceneIds: [third, second, first] };
		expect((await applySceneOrder(db, firstStoryId, swapped)).ok).toBe(true);
		expect(await arcStale(bram.id)).toBe(false);
		expect(await arcStale(cass.id)).toBe(true);
	});

	it('goes stale when a story it reads is renamed', async () => {
		const bram = await makeCharacter();
		await sceneWithProse('Bram at the harbour.');
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		const enrichedAt = new Date('2026-01-01T00:00:00Z');
		await db
			.update(characters)
			.set({ assistantEnrichedAt: enrichedAt })
			.where(eq(characters.id, bram.id));
		const [story] = await db
			.select({ id: stories.id, title: stories.title, slug: stories.slug })
			.from(stories)
			.where(eq(stories.id, firstStoryId));
		const details = {
			author: null,
			brief: 'A brief.',
			descriptionMd: null,
			styleNotes: null,
			coverColor: null
		};

		await saveStoryDetails(db, ownerId, story, { ...details, title: story.title });
		expect(await arcStale(bram.id)).toBe(false);

		await saveStoryDetails(db, ownerId, story, { ...details, title: 'The Deep Tide' });
		const after = await readCharacter(bram.id);
		expect(await arcStale(bram.id)).toBe(true);
		expect(after.assistantEnrichedAt).toEqual(enrichedAt);
	});

	it('goes stale when the character is renamed', async () => {
		const bram = await makeCharacter();
		await sceneWithProse('Bram at the harbour.');
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		const enrichedAt = new Date('2026-01-01T00:00:00Z');
		await db
			.update(characters)
			.set({ assistantEnrichedAt: enrichedAt })
			.where(eq(characters.id, bram.id));
		const save = { tags: [], summaryMd: 'A sailor.', bodyMd: 'Notes.' };

		expect(
			(await saveEntity(db, 'character', bram.id, ownerId, { ...save, name: 'Bram' })).ok
		).toBe(true);
		expect(await arcStale(bram.id)).toBe(false);

		expect(
			(await saveEntity(db, 'character', bram.id, ownerId, { ...save, name: 'Bram Tull' })).ok
		).toBe(true);
		const after = await readCharacter(bram.id);
		expect(await arcStale(bram.id)).toBe(true);
		expect(after.assistantEnrichedAt).toEqual(enrichedAt);
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
		expect(await arcStale(bram.id)).toBe(false);
	});

	it('stays current through an edit past the passage it reads', async () => {
		const bram = await makeCharacter();
		const filler = ' The tide ran out over the flats.'.repeat(6);
		const sceneId = await sceneWithProse(`Bram at the harbour.${filler} Bram waved.`);
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);

		// The arc reads the passage around the first mention only.
		await db
			.update(scenes)
			.set({ bodyMd: `Bram at the harbour.${filler} Bram waved twice.` })
			.where(eq(scenes.id, sceneId));
		await rebuildSceneMentions(db, sceneId);
		expect(await arcStale(bram.id)).toBe(false);

		// An edit it does read.
		await db
			.update(scenes)
			.set({ bodyMd: `Bram on the quay.${filler} Bram waved twice.` })
			.where(eq(scenes.id, sceneId));
		await rebuildSceneMentions(db, sceneId);
		expect(await arcStale(bram.id)).toBe(true);
		reply = 'A different arc.';
		expect(
			(await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps)).outcome
		).toBe('written');
		expect((await readCharacter(bram.id)).arcSummaryMd).toBe('A different arc.');
		expect(await arcStale(bram.id)).toBe(false);
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

	it('reindexes a scene while the characters it mentions are locked', async () => {
		const bram = await makeCharacter();
		const sceneId = await sceneWithProse('Bram at the harbour.');
		await db.update(scenes).set({ bodyMd: 'Bram on the quay.' }).where(eq(scenes.id, sceneId));
		// An entity save in another tab holds the character row.
		const save = await pool.connect();
		try {
			await save.query('begin');
			await save.query('select id from characters where id = $1 for update', [bram.id]);
			expect(await rebuildSceneMentions(db, sceneId)).toEqual({ ok: true, count: 1 });
			await save.query('commit');
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
		expect(await arcStale(bram.id)).toBe(true);
		// Rewritten without the deleted story, then the story comes back.
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		expect(await arcStale(bram.id)).toBe(false);
		expect(await restoreStory(db, ownerId, secondStoryId)).toBe(true);
		expect(await arcStale(bram.id)).toBe(true);
	});
});

describe('saves that change what an arc reads', () => {
	// Any update to characters fails: these saves must not write to them.
	async function withoutCharacterWrites(run: () => Promise<unknown>) {
		await pool.query(`create or replace function arc_test_fail() returns trigger as $$
			begin raise exception 'a save wrote to characters'; end $$ language plpgsql`);
		await pool.query(
			'create trigger arc_test_fail before update on characters for each statement execute function arc_test_fail()'
		);
		try {
			await run();
		} finally {
			await pool.query('drop trigger arc_test_fail on characters');
			await pool.query('drop function arc_test_fail()');
		}
	}

	it('write nothing to the characters: trash, restore, mute and unmute a story', async () => {
		const bram = await makeCharacter();
		await sceneMentioning(secondStoryId, bram.id, { position: 1, snippet: 'Bram' });
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		await withoutCharacterWrites(async () => {
			expect(await trashStory(db, ownerId, secondStoryId)).toBe(true);
			expect(await arcStale(bram.id)).toBe(true);
			expect(await restoreStory(db, ownerId, secondStoryId)).toBe(true);
			expect(await arcStale(bram.id)).toBe(false);
			await saveStoryLlmOverride(db, secondStoryId, { enabled: false });
			expect(await arcStale(bram.id)).toBe(true);
			await saveStoryLlmOverride(db, secondStoryId, { enabled: null });
			expect(await arcStale(bram.id)).toBe(false);
		});
	});
});

describe('muting and unmuting a story', () => {
	it('puts an arc that read the story out of date on a mute, and leaves the others current', async () => {
		const bram = await makeCharacter();
		const other = await makeCharacter();
		const edited = await makeCharacter();
		await sceneMentioning(firstStoryId, bram.id, { position: 1, snippet: 'Bram at the quay' });
		await sceneMentioning(secondStoryId, bram.id, { position: 1, snippet: 'Bram in private' });
		await sceneMentioning(firstStoryId, other.id, { position: 2, snippet: 'Bram elsewhere' });
		const sceneId = await sceneMentioning(secondStoryId, edited.id, {
			position: 2,
			snippet: 'Bram in private again'
		});
		for (const character of [bram, other, edited]) {
			await summariseCharacterArc(db, { userId: ownerId, characterId: character.id }, deps);
		}
		// An arc stays out of date when its mention was edited away before the mute.
		await db.delete(entityMentions).where(eq(entityMentions.sourceId, sceneId));

		await saveStoryLlmOverride(db, secondStoryId, { enabled: false });
		expect(await arcStale(bram.id)).toBe(true);
		expect(await arcStale(edited.id)).toBe(true);
		expect(await arcStale(other.id)).toBe(false);
		// Unmuted with nothing changed, the arc is what would be written again.
		await saveStoryLlmOverride(db, secondStoryId, { enabled: null });
		expect(await arcStale(bram.id)).toBe(false);
	});

	it('shows an arc as out of date when the story is unmuted while it is written', async () => {
		const bram = await makeCharacter();
		await sceneMentioning(firstStoryId, bram.id, { position: 1, snippet: 'Bram' });
		await sceneMentioning(secondStoryId, bram.id, { position: 1, snippet: 'Bram in private' });
		await saveStoryLlmOverride(db, secondStoryId, { enabled: false });
		duringCall = () => saveStoryLlmOverride(db, secondStoryId, { enabled: null });
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		const [after] = await db.select().from(characters).where(eq(characters.id, bram.id));
		expect(after.arcSummaryMd).not.toBeNull();
		expect(await arcStale(bram.id)).toBe(true);
	});

	it('keeps arcs written after a mute when the story is muted again', async () => {
		const bram = await makeCharacter();
		await sceneMentioning(firstStoryId, bram.id, { position: 1, snippet: 'Bram' });
		await saveStoryLlmOverride(db, secondStoryId, { enabled: false });
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		await saveStoryLlmOverride(db, secondStoryId, { enabled: false });
		expect((await readArc(bram.id)).arcSummaryMd).not.toBeNull();
	});

	it('shows arcs as out of date on an unmute', async () => {
		const bram = await makeCharacter();
		await sceneMentioning(firstStoryId, bram.id, { position: 1, snippet: 'Bram' });
		await saveStoryLlmOverride(db, secondStoryId, { enabled: false });
		await sceneMentioning(secondStoryId, bram.id, { position: 1, snippet: 'Bram in private' });
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		const [before] = await db.select().from(characters).where(eq(characters.id, bram.id));
		expect(await arcStale(bram.id)).toBe(false);

		await saveStoryLlmOverride(db, secondStoryId, { enabled: null });
		const [after] = await db.select().from(characters).where(eq(characters.id, bram.id));
		expect(after.arcSummaryMd).toBe(before.arcSummaryMd);
		expect(await arcStale(bram.id)).toBe(true);
	});
});

// Text of a story the Assistant is turned off for must not reach the model
// through an arc that retold it, whatever happens to the story afterwards.
describe('an out-of-date arc and a muted story', () => {
	const ARC = 'Bram leaves the harbour and becomes a captain.';
	let bramId: string;
	let sceneA: string;
	let sceneB: string;

	// An arc written from both stories.
	beforeEach(async () => {
		bramId = (await makeCharacter()).id;
		sceneA = await sceneMentioning(firstStoryId, bramId, { position: 1, snippet: 'Bram at sea' });
		sceneB = await sceneMentioning(secondStoryId, bramId, {
			position: 1,
			snippet: 'Bram in private'
		});
		await summariseCharacterArc(db, { userId: ownerId, characterId: bramId }, deps);
	});

	const contextText = async () =>
		(await assembleContext(db, { userId: ownerId, storyId: firstStoryId, sceneId: sceneA }))!.text;

	it('is sent while the story is read, and left out once it is muted', async () => {
		expect(await contextText()).toContain(`Across the stories: ${ARC}`);
		await saveStoryLlmOverride(db, secondStoryId, { enabled: false });
		expect(await contextText()).not.toContain(ARC);
	});

	it('stays out when the muted scene that mentioned the character is deleted', async () => {
		await saveStoryLlmOverride(db, secondStoryId, { enabled: false });
		expect(await trashScene(db, ownerId, sceneB)).toBe(true);
		expect(await contextText()).not.toContain(ARC);
	});

	it('stays out when the character is written out of the muted story', async () => {
		await saveStoryLlmOverride(db, secondStoryId, { enabled: false });
		await db.delete(entityMentions).where(eq(entityMentions.sourceId, sceneB));
		expect(await contextText()).not.toContain(ARC);
	});

	it('stays out when the muted story is deleted for good', async () => {
		await saveStoryLlmOverride(db, secondStoryId, { enabled: false });
		await purgeStory(db, secondStoryId);
		expect(await contextText()).not.toContain(ARC);
	});

	it('stays out when a story it read is deleted for good without a mute', async () => {
		await purgeStory(db, secondStoryId);
		expect(await contextText()).not.toContain(ARC);
	});

	it('comes back when the story is unmuted', async () => {
		await saveStoryLlmOverride(db, secondStoryId, { enabled: false });
		await saveStoryLlmOverride(db, secondStoryId, { enabled: null });
		expect(await contextText()).toContain(`Across the stories: ${ARC}`);

		// Out of date for another reason, it comes back with its note.
		await saveStoryLlmOverride(db, secondStoryId, { enabled: false });
		await db.update(scenes).set({ summaryMd: 'Bram sails.' }).where(eq(scenes.id, sceneA));
		expect(await contextText()).not.toContain(ARC);
		await saveStoryLlmOverride(db, secondStoryId, { enabled: null });
		expect(await contextText()).toMatch(/Across the stories \(written before[^)]*\): Bram leaves/);
	});

	it('is sent with its note when out of date and every story it read is still read', async () => {
		await db.update(scenes).set({ summaryMd: 'Bram sails.' }).where(eq(scenes.id, sceneA));
		// Muting a story the arc never read does not hide it.
		const [third] = await db
			.insert(stories)
			.values({ universeId, ownerId, title: 'Apart', positionInSeries: 3 })
			.returning({ id: stories.id });
		await sceneMentioning(third.id, bramId, { position: 1, snippet: 'Bram apart' });
		await saveStoryLlmOverride(db, third.id, { enabled: false });
		expect(await contextText()).toMatch(/Across the stories \(written before[^)]*\): Bram leaves/);
	});

	it('is left out when the stories it read were never recorded', async () => {
		await db.update(scenes).set({ summaryMd: 'Bram sails.' }).where(eq(scenes.id, sceneA));
		await pool.query('update characters set arc_summary_stories = null where id = $1', [bramId]);
		expect(await contextText()).not.toContain(ARC);
	});

	it('holds for an arc from before the stories it read were recorded', async () => {
		// As migration 0093 leaves such an arc: no fingerprint it can match, and
		// every story of its universe on its list.
		const [third] = await db
			.insert(stories)
			.values({ universeId, ownerId, title: 'Apart', positionInSeries: 3 })
			.returning({ id: stories.id });
		await db
			.update(characters)
			.set({ arcSummaryInput: null, arcSummaryStories: [firstStoryId, secondStoryId, third.id] })
			.where(eq(characters.id, bramId));
		expect(await contextText()).toMatch(/Across the stories \(written before[^)]*\): Bram leaves/);
		await saveStoryLlmOverride(db, secondStoryId, { enabled: false });
		expect(await contextText()).not.toContain(ARC);
		await purgeStory(db, secondStoryId);
		expect(await contextText()).not.toContain(ARC);
	});

	it('records only the stories read, and a rewrite after a mute drops the muted one', async () => {
		const read = async () =>
			(
				await pool.query('select arc_summary_stories as ids from characters where id = $1', [
					bramId
				])
			).rows[0].ids as string[];
		expect([...(await read())].sort()).toEqual([firstStoryId, secondStoryId].sort());
		await saveStoryLlmOverride(db, secondStoryId, { enabled: false });
		reply = 'Bram stays at sea.';
		await summariseCharacterArc(db, { userId: ownerId, characterId: bramId }, deps);
		expect(await read()).toEqual([firstStoryId]);
		expect(await contextText()).toContain('Across the stories: Bram stays at sea.');
	});
});
