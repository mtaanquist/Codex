import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	characters,
	entityMentions,
	loreEntries,
	places,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import type { GatewayDeps } from '../../src/lib/server/llm/gateway';
import type { ChatMessage, HttpRequest, Provider } from '../../src/lib/server/llm/providers/types';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

// Storing the account API key encrypts it with APP_SECRET (needed for enrich).
process.env.APP_SECRET = process.env.APP_SECRET || 'entity-enrich-test-secret';

const { stageEntitySuggestions, decideEntitySuggestion, listPendingForEntity } =
	await import('../../src/lib/server/entity-suggestions');
const { enrichEntity, enrichUniverse, universeEnrichTargets } =
	await import('../../src/lib/server/llm/enrich');
const { saveAccountLlmConfig, saveModelPricing } = await import('../../src/lib/server/llm/config');

const enrichJson =
	'{"aliases":["The Grey"],"details":[{"label":"Eyes","value":"grey"}],"summary":"A weary swordsman."}';
const stubProvider: Provider = {
	async *chatStream() {
		yield { type: 'done' };
	},
	async respond() {
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
		'truncate table entity_suggestions, entity_mentions, revisions, scenes, characters, places, lore_entries, stories, universes, users cascade'
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
	it('stages the aliases, details, and summary the Assistant returns', async () => {
		await saveAccountLlmConfig(db, ownerId, {
			enabled: true,
			assistantName: '',
			persona: 'balanced',
			endpoint: 'https://api.example.com/v1',
			apiKey: 'sk',
			models: { chat: 'chat-model' },
			toolCallBudget: 8
		});
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
});

describe('enrichUniverse', () => {
	async function configure(extra: { spendCapUsd?: number } = {}) {
		await saveAccountLlmConfig(db, ownerId, {
			enabled: true,
			assistantName: '',
			persona: 'balanced',
			endpoint: 'https://api.example.com/v1',
			apiKey: 'sk',
			models: { chat: 'chat-model' },
			toolCallBudget: 8,
			...extra
		});
	}

	// A scene in its own story of this universe, mentioning each target once.
	async function mention(
		storyTitle: string,
		targets: { type: 'character' | 'place' | 'lore_entry'; id: string; text: string }[]
	) {
		const [story] = await db
			.insert(stories)
			.values({ universeId, ownerId, title: storyTitle })
			.returning({ id: stories.id });
		const [scene] = await db
			.insert(scenes)
			.values({ storyId: story.id, globalPosition: 1, title: 'Opening', bodyMd: 'Prose.' })
			.returning({ id: scenes.id });
		await db.insert(entityMentions).values(
			targets.map((t, i) => ({
				sourceType: 'scene',
				sourceId: scene.id,
				targetType: t.type,
				targetId: t.id,
				position: i,
				surroundingText: t.text
			}))
		);
	}

	function recording(reply: (call: number) => string | Error) {
		const seen: ChatMessage[][] = [];
		const provider: Provider = {
			async *chatStream() {
				yield { type: 'done' };
			},
			async respond(req) {
				seen.push(req.messages);
				const out = reply(seen.length);
				if (out instanceof Error) throw out;
				return {
					content: out,
					toolCalls: [],
					usage: { promptTokens: 1000, completionTokens: 0 }
				};
			},
			async listModels() {
				return [];
			}
		};
		return { seen, deps: { provider, http: noHttp } satisfies GatewayDeps };
	}

	it('asks about mentioned entries only, skipping ones with suggestions waiting', async () => {
		const bram = await makeCharacter({ name: 'Bram' });
		const quiet = await makeCharacter({ name: 'Unmentioned' });
		const waiting = await makeCharacter({ name: 'Waiting' });
		const [harbour] = await db
			.insert(places)
			.values({ universeId, ownerId, name: 'Harbour' })
			.returning({ id: places.id });
		const [tide] = await db
			.insert(loreEntries)
			.values({ universeId, ownerId, title: 'The Tide' })
			.returning({ id: loreEntries.id });
		await mention('Book One', [
			{ type: 'character', id: bram, text: 'Bram at the gate.' },
			{ type: 'character', id: waiting, text: 'Waiting by the wall.' },
			{ type: 'place', id: harbour.id, text: 'The harbour was quiet.' },
			{ type: 'lore_entry', id: tide.id, text: 'The tide turned.' }
		]);
		await stageEntitySuggestions(db, {
			ownerId,
			kind: 'character',
			entityId: waiting,
			proposals: [{ field: 'alias', value: 'W' }]
		});

		const targets = await universeEnrichTargets(db, { userId: ownerId, universeId });
		const ids = targets.map((t) => t.id);
		expect(ids).toEqual(expect.arrayContaining([bram, harbour.id, tide.id]));
		expect(ids).not.toContain(quiet);
		expect(ids).not.toContain(waiting);
		expect(targets.find((t) => t.id === tide.id)?.kind).toBe('lore');
	});

	it('stages suggestions on every entry, reading appearances across stories', async () => {
		await configure();
		const bram = await makeCharacter({ name: 'Bram' });
		const [harbour] = await db
			.insert(places)
			.values({ universeId, ownerId, name: 'Harbour' })
			.returning({ id: places.id });
		await mention('Book One', [{ type: 'character', id: bram, text: 'Bram at the gate.' }]);
		await mention('Book Two', [
			{ type: 'character', id: bram, text: 'Bram, older now.' },
			{ type: 'place', id: harbour.id, text: 'The harbour burned.' }
		]);
		const { seen, deps: run } = recording(() => enrichJson);

		const result = await enrichUniverse(db, { userId: ownerId, universeId }, run);
		expect(result).toMatchObject({ entries: 2, enriched: 2, failed: 0 });
		expect(result.suggestions).toBeGreaterThanOrEqual(2);
		expect(await listPendingForEntity(db, ownerId, 'character', bram)).not.toHaveLength(0);
		expect(await listPendingForEntity(db, ownerId, 'place', harbour.id)).not.toHaveLength(0);

		const bramPrompt = seen
			.flat()
			.map((m) => m.content)
			.find((c) => c.includes('"Bram"'));
		expect(bramPrompt).toContain('[Book One / Opening] Bram at the gate.');
		expect(bramPrompt).toContain('[Book Two / Opening] Bram, older now.');

		// Everything now has suggestions waiting, so a second run asks nothing.
		const again = await enrichUniverse(db, { userId: ownerId, universeId }, run);
		expect(again.entries).toBe(0);
	});

	it('counts a failed entry and carries on with the rest', async () => {
		await configure();
		const a = await makeCharacter({ name: 'Ada' });
		const b = await makeCharacter({ name: 'Bram' });
		await mention('Book One', [
			{ type: 'character', id: a, text: 'Ada.' },
			{ type: 'character', id: b, text: 'Bram.' }
		]);
		const { deps: run } = recording((call) => (call === 1 ? new Error('boom') : enrichJson));

		const result = await enrichUniverse(db, { userId: ownerId, universeId }, run);
		expect(result).toMatchObject({ entries: 2, enriched: 1, failed: 1 });
	});

	it('stops at the spend cap between entries', async () => {
		await configure({ spendCapUsd: 0.5 });
		await saveModelPricing(db, ownerId, { 'chat-model': { prompt: 0.001, completion: 0 } });
		const a = await makeCharacter({ name: 'Ada' });
		const b = await makeCharacter({ name: 'Bram' });
		await mention('Book One', [
			{ type: 'character', id: a, text: 'Ada.' },
			{ type: 'character', id: b, text: 'Bram.' }
		]);
		const { seen, deps: run } = recording(() => enrichJson);

		const result = await enrichUniverse(db, { userId: ownerId, universeId }, run);
		expect(seen).toHaveLength(1);
		expect(result).toMatchObject({ entries: 1, capped: true });
	});

	it('does nothing for a universe the user does not own', async () => {
		await configure();
		const bram = await makeCharacter({ name: 'Bram' });
		await mention('Book One', [{ type: 'character', id: bram, text: 'Bram.' }]);
		const { seen, deps: run } = recording(() => enrichJson);

		const result = await enrichUniverse(db, { userId: strangerId, universeId }, run);
		expect(result.entries).toBe(0);
		expect(seen).toHaveLength(0);
	});
});
