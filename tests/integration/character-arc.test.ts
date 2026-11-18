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
import { trashScene } from '../../src/lib/server/scene-lifecycle';

// Storing the account API key encrypts it with APP_SECRET.
process.env.APP_SECRET = process.env.APP_SECRET || 'character-arc-test-secret';

const { summariseCharacterArc, arcIsStale, planArc } =
	await import('../../src/lib/server/llm/arc-summary');
const { saveAccountLlmConfig, saveStoryLlmOverride } =
	await import('../../src/lib/server/llm/config');

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
		).rejects.toThrow();
		expect((await readArc(bram.id)).arcSummaryMd).toBeNull();
	});

	it('keeps an out-of-date mark set while the arc was being rewritten', async () => {
		const bram = await makeCharacter();
		await sceneMentioning(firstStoryId, bram.id, { position: 1, snippet: 'Bram at the quay' });
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		// An unmute or a scene delete lands while the model writes the new arc.
		duringCall = async () => {
			await pool.query(`update characters set arc_summary_at = to_timestamp(0) where id = $1`, [
				bram.id
			]);
		};
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		const [after] = await db.select().from(characters).where(eq(characters.id, bram.id));
		expect(after.arcSummaryAt?.getTime()).toBe(0);
		expect(await arcIsStale(db, after)).toBe(true);
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

	it('goes stale when a mentioning scene is deleted', async () => {
		const bram = await makeCharacter();
		const sceneId = await sceneMentioning(firstStoryId, bram.id, { position: 1, snippet: 'Bram' });
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		const [written] = await db.select().from(characters).where(eq(characters.id, bram.id));
		expect(await arcIsStale(db, written)).toBe(false);
		expect(await trashScene(db, ownerId, sceneId)).toBe(true);
		const [after] = await db.select().from(characters).where(eq(characters.id, bram.id));
		expect(await arcIsStale(db, after)).toBe(true);
	});

	it('goes stale when a story it read is deleted', async () => {
		const bram = await makeCharacter();
		await sceneMentioning(firstStoryId, bram.id, { position: 1, snippet: 'Bram' });
		await sceneMentioning(secondStoryId, bram.id, { position: 1, snippet: 'Bram again' });
		await summariseCharacterArc(db, { userId: ownerId, characterId: bram.id }, deps);
		const [written] = await db.select().from(characters).where(eq(characters.id, bram.id));
		expect(await arcIsStale(db, written)).toBe(false);
		await pool.query(`update stories set deleted_at = now() + interval '1 minute' where id = $1`, [
			secondStoryId
		]);
		expect(await arcIsStale(db, written)).toBe(true);
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
		expect(await arcIsStale(db, before)).toBe(false);

		await saveStoryLlmOverride(db, secondStoryId, { enabled: null });
		const [after] = await db.select().from(characters).where(eq(characters.id, bram.id));
		expect(after.arcSummaryMd).toBe(before.arcSummaryMd);
		expect(await arcIsStale(db, after)).toBe(true);
		expect(after.assistantEnrichedAt).toBeNull();
	});
});
