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

// Storing the account API key encrypts it with APP_SECRET.
process.env.APP_SECRET = process.env.APP_SECRET || 'character-arc-test-secret';

const { summariseCharacterArc, arcIsStale, planArc } =
	await import('../../src/lib/server/llm/arc-summary');
const { saveAccountLlmConfig, saveStoryLlmOverride } =
	await import('../../src/lib/server/llm/config');

let lastPrompt = '';
let calls = 0;
let reply = 'Bram leaves the harbour and becomes a captain.';
const stubProvider: Provider = {
	async *chatStream() {
		yield { type: 'done' };
	},
	async respond(req) {
		lastPrompt = JSON.stringify(req.messages);
		calls += 1;
		return { content: reply, toolCalls: [] };
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
	lastPrompt = '';
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
});

describe('arc staleness', () => {
	it('goes stale when a mentioning scene changes after the arc was written', async () => {
		const bram = await makeCharacter();
		const sceneId = await sceneMentioning(firstStoryId, bram.id, { position: 1, snippet: 'Bram' });
		const never = await db.select().from(characters).where(eq(characters.id, bram.id));
		expect(await planArc(db, { kind: 'character', entity: never[0] })).toEqual({
			summaryMd: null,
			stale: false
		});

		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		const [written] = await db.select().from(characters).where(eq(characters.id, bram.id));
		expect(await arcIsStale(db, written)).toBe(false);

		await db
			.update(scenes)
			.set({ updatedAt: new Date(Date.now() + 60_000) })
			.where(eq(scenes.id, sceneId));
		expect(await arcIsStale(db, written)).toBe(true);
		expect(await planArc(db, { kind: 'place', entity: written })).toBeNull();
	});
});
