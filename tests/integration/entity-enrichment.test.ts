import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { characters, stories, universes, users } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import type { GatewayDeps } from '../../src/lib/server/llm/gateway';
import type { HttpRequest, Provider } from '../../src/lib/server/llm/providers/types';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

// Storing the account API key encrypts it with APP_SECRET (needed for enrich).
process.env.APP_SECRET = process.env.APP_SECRET || 'entity-enrich-test-secret';

const { stageEntitySuggestions, decideEntitySuggestion, listPendingForEntity } =
	await import('../../src/lib/server/entity-suggestions');
const { enrichEntity } = await import('../../src/lib/server/llm/enrich');
const { saveAccountLlmConfig } = await import('../../src/lib/server/llm/config');

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
		'truncate table entity_suggestions, revisions, characters, stories, universes, users cascade'
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
		const staged = await enrichEntity(db, { userId: ownerId, storyId, entityId: id }, deps);
		const fields = staged.map((s) => s.field);
		expect(fields).toContain('alias');
		expect(fields).toContain('detail');
		expect(fields).toContain('summary');
		expect(await listPendingForEntity(db, ownerId, 'character', id)).toHaveLength(staged.length);
	});
});
