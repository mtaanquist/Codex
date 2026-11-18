import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type pg from 'pg';
import { reviewThreads, scenes, stories, universes, users } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase } from './test-db';

// The author review page's clear action, called as the real handler.

vi.mock('#lib/server/db', async () => {
	const { default: pgModule } = await import('pg');
	const { drizzle } = await import('drizzle-orm/node-postgres');
	const schemaModule = await import('../../src/lib/server/db/schema');
	const { TEST_DATABASE_URL } = await import('./test-db');
	const testPool = new pgModule.Pool({ connectionString: TEST_DATABASE_URL });
	return { db: drizzle(testPool, { schema: schemaModule }), pool: testPool };
});

const { db, pool } = (await import('#lib/server/db')) as unknown as {
	db: Database;
	pool: pg.Pool;
};
const page = await import('../../src/routes/stories/[id]/review/+page.server');

type User = { id: string; displayName: string };
let owner: User;
let stranger: User;
let storyId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query('truncate table users cascade');
	const made = await db
		.insert(users)
		.values([
			{ email: 'a@example.com', displayName: 'Avery', passwordHash: 'x', role: 'user' },
			{ email: 'b@example.com', displayName: 'Blake', passwordHash: 'x', role: 'user' }
		])
		.returning({ id: users.id, displayName: users.displayName });
	[owner, stranger] = made;
	const [universe] = await db
		.insert(universes)
		.values({ ownerId: owner.id, name: 'U' })
		.returning({ id: universes.id });
	const [story] = await db
		.insert(stories)
		.values({ universeId: universe.id, ownerId: owner.id, title: 'S' })
		.returning({ id: stories.id });
	storyId = story.id;
	const [scene] = await db
		.insert(scenes)
		.values({ storyId, globalPosition: 1, bodyMd: 'Text.' })
		.returning({ id: scenes.id });
	await db.insert(reviewThreads).values({ storyId, sceneId: scene.id, resolvedAt: new Date() });
});

afterAll(async () => {
	await pool.end();
});

function clear(user: User, scope: string, seenAt = new Date(Date.now() + 60_000).toISOString()) {
	const form = new FormData();
	form.set('scope', scope);
	form.set('seenAt', seenAt);
	const url = new URL(`http://localhost/stories/${storyId}/review`);
	return page.actions.clearReviews({
		params: { id: storyId },
		url,
		request: new Request(url, { method: 'POST', body: form }),
		locals: { user, session: null },
		cookies: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), getAll: vi.fn(() => []) },
		getClientAddress: () => '127.0.0.1'
	} as unknown as Parameters<typeof page.actions.clearReviews>[0]);
}

describe('clearReviews action', () => {
	it("refuses another user's story and leaves its notes", async () => {
		await expect(clear(stranger, 'all')).rejects.toMatchObject({ status: 404 });
		expect(await db.select().from(reviewThreads)).toHaveLength(1);
	});

	it('rejects an unknown scope', async () => {
		const result = await clear(owner, 'everything');
		expect(result).toMatchObject({ status: 400 });
		expect(await db.select().from(reviewThreads)).toHaveLength(1);
	});

	it('asks for a reload when the page time is missing', async () => {
		const result = await clear(owner, 'all', '');
		expect(result).toMatchObject({ status: 400 });
		expect(await db.select().from(reviewThreads)).toHaveLength(1);
	});

	it('clears for the owner', async () => {
		expect(await clear(owner, 'finished')).toEqual({ done: true });
		expect(await db.select().from(reviewThreads)).toHaveLength(0);
	});
});
