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

// Storing the account API key encrypts it with APP_SECRET (needed for enrich).
process.env.APP_SECRET = process.env.APP_SECRET || 'entity-enrich-test-secret';

const { stageEntitySuggestions, decideEntitySuggestion, listPendingForEntity } =
	await import('../../src/lib/server/entity-suggestions');
const { enrichEntity, enrichUniverse } = await import('../../src/lib/server/llm/enrich');
const { saveAccountLlmConfig, saveModelPricing } = await import('../../src/lib/server/llm/config');

const enrichJson =
	'{"aliases":["The Grey"],"details":[{"label":"Eyes","value":"grey"}],"summary":"A weary swordsman."}';
// The last prompt the stub was sent, to check which passages reached it, and
// how many completions it served.
let lastPrompt = '';
let calls = 0;
const stubProvider: Provider = {
	async *chatStream() {
		yield { type: 'done' };
	},
	async respond(req) {
		lastPrompt = JSON.stringify(req.messages);
		calls += 1;
		return { content: enrichJson, toolCalls: [] };
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
let storyId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query(
		'truncate table entity_suggestions, entity_mentions, revisions, characters, stories, universes, users cascade'
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
	const [story] = await db
		.insert(stories)
		.values({ universeId, ownerId, title: 'The Tide Below' })
		.returning({ id: stories.id });
	storyId = story.id;
});

afterAll(async () => {
	await pool.end();
});

async function makeCharacter(over: Partial<typeof characters.$inferInsert> = {}) {
	const [c] = await db
		.insert(characters)
		.values({ universeId, ownerId, name: 'Bram', ...over })
		.returning({ id: characters.id });
	return c.id;
}

async function readChar(id: string) {
	const [row] = await db
		.select({
			aliases: characters.aliases,
			details: characters.details,
			summaryMd: characters.summaryMd
		})
		.from(characters)
		.where(eq(characters.id, id));
	return row;
}

describe('stageEntitySuggestions', () => {
	it('drops duplicates of existing aliases, detail labels, and an existing summary', async () => {
		const id = await makeCharacter({
			aliases: ['Al'],
			details: [{ label: 'Eyes', value: 'grey' }],
			summaryMd: 'A swordsman.'
		});
		const staged = await stageEntitySuggestions(db, {
			ownerId,
			kind: 'character',
			entityId: id,
			proposals: [
				{ field: 'alias', value: 'Al' }, // dup
				{ field: 'alias', value: 'The Grey' }, // new
				{ field: 'detail', label: 'Eyes', value: 'blue' }, // dup label
				{ field: 'detail', label: 'Age', value: '40' }, // new
				{ field: 'summary', value: 'ignored' } // has a summary
			]
		});
		const fields = staged.map((s) => `${s.field}:${s.label ?? s.value}`);
		expect(fields).toContain('alias:The Grey');
		expect(fields).toContain('detail:Age');
		expect(fields).not.toContain('alias:Al');
		expect(fields.some((f) => f.startsWith('summary'))).toBe(false);
	});

	it('does not stage again what the writer rejected', async () => {
		const id = await makeCharacter();
		const first = await stageEntitySuggestions(db, {
			ownerId,
			kind: 'character',
			entityId: id,
			proposals: [
				{ field: 'alias', value: 'The Grey' },
				{ field: 'detail', label: 'Eyes', value: 'blue' }
			]
		});
		for (const s of first) await decideEntitySuggestion(db, ownerId, s.id, 'reject');
		const again = await stageEntitySuggestions(db, {
			ownerId,
			kind: 'character',
			entityId: id,
			proposals: [
				{ field: 'alias', value: 'the grey' }, // rejected, any case
				{ field: 'detail', label: 'Eyes', value: 'Blue' }, // rejected pair
				{ field: 'detail', label: 'Eyes', value: 'grey' } // same label, new value
			]
		});
		expect(again.map((s) => `${s.field}:${s.label ?? ''}:${s.value}`)).toEqual([
			'detail:Eyes:grey'
		]);
	});
});

describe('decideEntitySuggestion', () => {
	it('accepting an alias adds it to the entity and clears the suggestion', async () => {
		const id = await makeCharacter();
		const [s] = await stageEntitySuggestions(db, {
			ownerId,
			kind: 'character',
			entityId: id,
			proposals: [{ field: 'alias', value: 'The Grey' }]
		});
		const result = await decideEntitySuggestion(db, ownerId, s.id, 'accept');
		expect(result.ok).toBe(true);
		expect((await readChar(id)).aliases).toContain('The Grey');
		expect(await listPendingForEntity(db, ownerId, 'character', id)).toHaveLength(0);
	});

	it('accepting a detail and a summary applies each to the entity', async () => {
		const id = await makeCharacter();
		const staged = await stageEntitySuggestions(db, {
			ownerId,
			kind: 'character',
			entityId: id,
			proposals: [
				{ field: 'detail', label: 'Eyes', value: 'grey' },
				{ field: 'summary', value: 'A weary swordsman.' }
			]
		});
		for (const s of staged) await decideEntitySuggestion(db, ownerId, s.id, 'accept');
		const c = await readChar(id);
		expect(c.details).toContainEqual({ label: 'Eyes', value: 'grey' });
		expect(c.summaryMd).toBe('A weary swordsman.');
	});

	it('rejecting leaves the entity untouched', async () => {
		const id = await makeCharacter();
		const [s] = await stageEntitySuggestions(db, {
			ownerId,
			kind: 'character',
			entityId: id,
			proposals: [{ field: 'alias', value: 'The Grey' }]
		});
		await decideEntitySuggestion(db, ownerId, s.id, 'reject');
		expect((await readChar(id)).aliases).not.toContain('The Grey');
		expect(await listPendingForEntity(db, ownerId, 'character', id)).toHaveLength(0);
	});

	it('does not let a stranger decide a suggestion', async () => {
		const id = await makeCharacter();
		const [s] = await stageEntitySuggestions(db, {
			ownerId,
			kind: 'character',
			entityId: id,
			proposals: [{ field: 'alias', value: 'The Grey' }]
		});
		const result = await decideEntitySuggestion(db, strangerId, s.id, 'accept');
		expect(result.ok).toBe(false);
		expect((await readChar(id)).aliases).not.toContain('The Grey');
	});
});

describe('enrichEntity', () => {
	const enableAssistant = () =>
		saveAccountLlmConfig(db, ownerId, {
			enabled: true,
			assistantName: '',
			persona: 'balanced',
			endpoint: 'https://api.example.com/v1',
			apiKey: 'sk',
			models: { chat: 'chat-model' },
			toolCallBudget: 8
		});

	async function mention(inStoryId: string, entityId: string, text: string) {
		const [scene] = await db
			.insert(scenes)
			.values({ storyId: inStoryId, globalPosition: 1, title: `Scene of ${text}` })
			.returning({ id: scenes.id });
		await db.insert(entityMentions).values({
			sourceType: 'scene',
			sourceId: scene.id,
			targetType: 'character',
			targetId: entityId,
			position: 0,
			surroundingText: text
		});
	}

	it('stages the aliases, details, and summary the Assistant returns', async () => {
		await enableAssistant();
		const id = await makeCharacter();
		const staged = await enrichEntity(
			db,
			{ userId: ownerId, scope: { storyId }, entityId: id },
			deps
		);
		const fields = staged.map((s) => s.field);
		expect(fields).toContain('alias');
		expect(fields).toContain('detail');
		expect(fields).toContain('summary');
		expect(await listPendingForEntity(db, ownerId, 'character', id)).toHaveLength(staged.length);
	});

	it('reads appearances from every story at universe scope, and only this one at story scope', async () => {
		await enableAssistant();
		const id = await makeCharacter();
		const [other] = await db
			.insert(stories)
			.values({ universeId, ownerId, title: 'The Salt Road' })
			.returning({ id: stories.id });
		await mention(storyId, id, 'Bram at the harbour');
		await mention(other.id, id, 'Bram on the road');

		await enrichEntity(db, { userId: ownerId, scope: { universeId }, entityId: id }, deps);
		expect(lastPrompt).toContain('Bram at the harbour');
		expect(lastPrompt).toContain('Bram on the road');
		expect(lastPrompt).toContain('The Salt Road');

		await enrichEntity(db, { userId: ownerId, scope: { storyId }, entityId: id }, deps);
		expect(lastPrompt).toContain('Bram at the harbour');
		expect(lastPrompt).not.toContain('Bram on the road');
	});

	it('stages nothing for an entity outside the given universe', async () => {
		await enableAssistant();
		const id = await makeCharacter();
		const [elsewhere] = await db
			.insert(universes)
			.values({ ownerId, name: 'Elsewhere' })
			.returning({ id: universes.id });
		const staged = await enrichEntity(
			db,
			{ userId: ownerId, scope: { universeId: elsewhere.id }, entityId: id },
			deps
		);
		expect(staged).toEqual([]);
	});
});

describe('enrichUniverse', () => {
	beforeEach(async () => {
		calls = 0;
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

	async function sceneMentioning(entityId: string, text: string) {
		const [scene] = await db
			.insert(scenes)
			.values({ storyId, globalPosition: 1, title: 'Harbour' })
			.returning({ id: scenes.id });
		await db.insert(entityMentions).values({
			sourceType: 'scene',
			sourceId: scene.id,
			targetType: 'character',
			targetId: entityId,
			position: 0,
			surroundingText: text
		});
		return scene.id;
	}

	it('reads only mentioned entities, marks them, and skips them until their prose changes', async () => {
		const mentioned = await makeCharacter({ name: 'Bram' });
		const unmentioned = await makeCharacter({ name: 'Cass' });
		const sceneId = await sceneMentioning(mentioned, 'Bram at the harbour');

		const first = await enrichUniverse(db, { userId: ownerId, universeId }, deps);
		expect(first).toMatchObject({ entities: 1, failed: 0 });
		expect(first.staged).toBeGreaterThan(0);
		expect(calls).toBe(1);
		const [marked] = await db
			.select({ at: characters.assistantEnrichedAt })
			.from(characters)
			.where(eq(characters.id, mentioned));
		expect(marked.at).not.toBeNull();
		const [skipped] = await db
			.select({ at: characters.assistantEnrichedAt })
			.from(characters)
			.where(eq(characters.id, unmentioned));
		expect(skipped.at).toBeNull();

		const second = await enrichUniverse(db, { userId: ownerId, universeId }, deps);
		expect(second).toMatchObject({ entities: 0, staged: 0 });
		expect(calls).toBe(1);

		await db
			.update(scenes)
			.set({ updatedAt: new Date(Date.now() + 60_000) })
			.where(eq(scenes.id, sceneId));
		const third = await enrichUniverse(db, { userId: ownerId, universeId }, deps);
		expect(third.entities).toBe(1);
		expect(calls).toBe(2);
	});

	async function enrichedAt(id: string) {
		const [row] = await db
			.select({ at: characters.assistantEnrichedAt })
			.from(characters)
			.where(eq(characters.id, id));
		return row.at;
	}

	it('stops at the spend cap and leaves the rest unmarked for the next pass', async () => {
		await saveAccountLlmConfig(db, ownerId, {
			enabled: true,
			assistantName: '',
			persona: 'balanced',
			endpoint: 'https://api.example.com/v1',
			apiKey: 'sk',
			models: { chat: 'chat-model' },
			toolCallBudget: 8,
			spendCapUsd: 0.5
		});
		await saveModelPricing(db, ownerId, { 'chat-model': { prompt: 0.001, completion: 0 } });
		const priced: GatewayDeps = {
			http: noHttp,
			provider: {
				...stubProvider,
				async respond(req) {
					calls += 1;
					lastPrompt = JSON.stringify(req.messages);
					return {
						content: enrichJson,
						toolCalls: [],
						usage: { promptTokens: 1000, completionTokens: 0 }
					};
				}
			}
		};
		const first = await makeCharacter({ name: 'Alda' });
		const second = await makeCharacter({ name: 'Bram' });
		await sceneMentioning(first, 'Alda at the gate');
		await sceneMentioning(second, 'Bram at the harbour');

		const result = await enrichUniverse(db, { userId: ownerId, universeId }, priced);
		expect(result).toMatchObject({ entities: 1, capped: true });
		expect(calls).toBe(1);
		expect(await enrichedAt(first)).not.toBeNull();
		expect(await enrichedAt(second)).toBeNull();
	});

	it('leaves out mentions in a trashed scene or story', async () => {
		const inTrashedScene = await makeCharacter({ name: 'Alda' });
		const inTrashedStory = await makeCharacter({ name: 'Bram' });
		const sceneId = await sceneMentioning(inTrashedScene, 'Alda at the gate');
		await db.update(scenes).set({ deletedAt: new Date() }).where(eq(scenes.id, sceneId));
		const [gone] = await db
			.insert(stories)
			.values({ universeId, ownerId, title: 'Gone', deletedAt: new Date() })
			.returning({ id: stories.id });
		const [scene] = await db
			.insert(scenes)
			.values({ storyId: gone.id, globalPosition: 1 })
			.returning({ id: scenes.id });
		await db.insert(entityMentions).values({
			sourceType: 'scene',
			sourceId: scene.id,
			targetType: 'character',
			targetId: inTrashedStory,
			position: 0,
			surroundingText: 'Bram'
		});

		const result = await enrichUniverse(db, { userId: ownerId, universeId }, deps);
		expect(result.entities).toBe(0);
		expect(calls).toBe(0);
	});

	it('stops when the job is stopped, marking nothing and saying so', async () => {
		const id = await makeCharacter();
		await sceneMentioning(id, 'Bram at the harbour');
		const controller = new AbortController();
		controller.abort();
		const result = await enrichUniverse(
			db,
			{ userId: ownerId, universeId, signal: controller.signal },
			deps
		);
		expect(result).toMatchObject({ entities: 0, aborted: true });
		expect(await enrichedAt(id)).toBeNull();
	});

	it("leaves another writer's universe alone", async () => {
		const id = await makeCharacter();
		await sceneMentioning(id, 'Bram at the harbour');
		const result = await enrichUniverse(db, { userId: strangerId, universeId }, deps);
		expect(result).toMatchObject({ entities: 0, staged: 0 });
		expect(calls).toBe(0);
	});

	it('does not mark an entity whose read failed, so the next pass tries again', async () => {
		const id = await makeCharacter();
		await sceneMentioning(id, 'Bram at the harbour');
		const failing: GatewayDeps = {
			http: noHttp,
			provider: {
				...stubProvider,
				async respond() {
					throw new Error('endpoint down');
				}
			}
		};
		const result = await enrichUniverse(db, { userId: ownerId, universeId }, failing);
		expect(result).toMatchObject({ entities: 0, failed: 1 });
		const [row] = await db
			.select({ at: characters.assistantEnrichedAt })
			.from(characters)
			.where(eq(characters.id, id));
		expect(row.at).toBeNull();
	});
});
