import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { chapters, scenes, stories, universes, users } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import type { GatewayDeps } from '../../src/lib/server/llm/gateway';
import type { HttpRequest, Provider } from '../../src/lib/server/llm/providers/types';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

// Storing the account API key encrypts it with APP_SECRET, so set one before the
// config helper loads (CI does not set it globally; each file that needs it does).
process.env.APP_SECRET = process.env.APP_SECRET || 'llm-summaries-test-secret';

const { saveAccountLlmConfig } = await import('../../src/lib/server/llm/config');
const { summariseStory } = await import('../../src/lib/server/llm/summaries');

// A stub provider that returns a distinct summary on each call, so a refresh is
// visible as a changed value. The transport is never reached.
let calls = 0;
const stubProvider: Provider = {
	async *chatStream() {
		yield { type: 'done' };
	},
	async respond() {
		calls += 1;
		return { content: `SUMMARY-${calls}`, toolCalls: [] };
	},
	async probe() {
		return { ok: true, supportsStreaming: true, supportsTools: false };
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
let storyId: string;
let chapterId: string;
let sceneAId: string;
let sceneBId: string;
let sceneCId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	calls = 0;
	await pool.query('truncate table scenes, chapters, stories, universes, users cascade');
	const [owner] = await db
		.insert(users)
		.values({ email: 'o@example.com', displayName: 'Olwen', passwordHash: 'x', role: 'user' })
		.returning({ id: users.id });
	ownerId = owner.id;
	await saveAccountLlmConfig(db, ownerId, {
		enabled: true,
		assistantName: '',
		persona: 'balanced',
		endpoint: 'https://api.example.com/v1',
		apiKey: 'sk',
		models: { chat: 'chat-model' },
		toolCallBudget: 8
	});

	const [universe] = await db
		.insert(universes)
		.values({ ownerId, name: 'Aldermoor' })
		.returning({ id: universes.id });
	const [story] = await db
		.insert(stories)
		.values({ universeId: universe.id, ownerId, title: 'The Tide Below' })
		.returning({ id: stories.id });
	storyId = story.id;
	const [chapter] = await db
		.insert(chapters)
		.values({ storyId, position: 1, title: 'Descent' })
		.returning({ id: chapters.id });
	chapterId = chapter.id;

	// A: has prose, no summary -> filled.
	const [a] = await db
		.insert(scenes)
		.values({
			storyId,
			chapterId,
			globalPosition: 1,
			title: 'The Gate',
			bodyMd: 'Alice met Bram by the gate at dawn.',
			status: 'draft'
		})
		.returning({ id: scenes.id });
	sceneAId = a.id;
	// B: has prose and a hand-written summary (no watermark) -> left alone.
	const [b] = await db
		.insert(scenes)
		.values({
			storyId,
			chapterId,
			globalPosition: 2,
			title: 'The Road',
			bodyMd: 'They walked south for days.',
			summaryMd: 'My own note.',
			status: 'draft'
		})
		.returning({ id: scenes.id });
	sceneBId = b.id;
	// C: empty prose -> nothing to summarise.
	const [c] = await db
		.insert(scenes)
		.values({ storyId, chapterId, globalPosition: 3, title: 'Stub', bodyMd: '', status: 'outline' })
		.returning({ id: scenes.id });
	sceneCId = c.id;
});

afterAll(async () => {
	await pool.end();
});

async function readScene(id: string) {
	const [row] = await db
		.select({
			summaryMd: scenes.summaryMd,
			summaryGeneratedAt: scenes.summaryGeneratedAt,
			updatedAt: scenes.updatedAt
		})
		.from(scenes)
		.where(eq(scenes.id, id));
	return row;
}

describe('summariseStory', () => {
	it('fills blank summaries, leaves hand-written ones, skips empty scenes, and drafts the chapter', async () => {
		const before = await readScene(sceneAId);
		const result = await summariseStory(db, { userId: ownerId, storyId }, deps);

		expect(result.scenes).toBe(1); // only A
		expect(result.chapters).toBe(1);
		expect(result.failed).toBe(0);

		const a = await readScene(sceneAId);
		expect(a.summaryMd).toMatch(/^SUMMARY-/);
		expect(a.summaryGeneratedAt).not.toBeNull();
		// The summary write preserves updated_at, so it does not register as an edit.
		expect(a.updatedAt.getTime()).toBe(before.updatedAt.getTime());

		const b = await readScene(sceneBId);
		expect(b.summaryMd).toBe('My own note.'); // untouched
		expect(b.summaryGeneratedAt).toBeNull();

		const c = await readScene(sceneCId);
		expect(c.summaryMd).toBeNull();

		const [chapter] = await db
			.select({ summaryMd: chapters.summaryMd, summaryGeneratedAt: chapters.summaryGeneratedAt })
			.from(chapters)
			.where(eq(chapters.id, chapterId));
		expect(chapter.summaryMd).toMatch(/^SUMMARY-/);
		expect(chapter.summaryGeneratedAt).not.toBeNull();
	});

	it('is a no-op on a second run when nothing changed', async () => {
		await summariseStory(db, { userId: ownerId, storyId }, deps);
		const again = await summariseStory(db, { userId: ownerId, storyId }, deps);
		expect(again.scenes).toBe(0);
		expect(again.chapters).toBe(0);
	});

	it('refreshes an Assistant-generated summary after the scene body changes', async () => {
		await summariseStory(db, { userId: ownerId, storyId }, deps);
		const first = await readScene(sceneAId);

		// A writer edit bumps updated_at past the summary watermark.
		await db
			.update(scenes)
			.set({ bodyMd: 'Alice met Bram, then ran.' })
			.where(eq(scenes.id, sceneAId));

		const result = await summariseStory(db, { userId: ownerId, storyId }, deps);
		expect(result.scenes).toBe(1);
		const second = await readScene(sceneAId);
		expect(second.summaryMd).not.toBe(first.summaryMd);
		expect(second.summaryGeneratedAt!.getTime()).toBeGreaterThan(
			first.summaryGeneratedAt!.getTime()
		);
	});

	it('does not run for a story the user does not own', async () => {
		const [stranger] = await db
			.insert(users)
			.values({ email: 's@example.com', displayName: 'Sam', passwordHash: 'x', role: 'user' })
			.returning({ id: users.id });
		const result = await summariseStory(db, { userId: stranger.id, storyId }, deps);
		expect(result.scenes).toBe(0);
		expect(result.chapters).toBe(0);
	});
});
