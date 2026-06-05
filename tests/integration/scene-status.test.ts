import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { scenes, stories, universes, users } from '../../src/lib/server/db/schema';
import { setSceneStatus } from '../../src/lib/server/scene-status';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let strangerId: string;
let sceneId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
	await pool.query('truncate table scenes, chapters, stories, universes, users cascade');

	const [owner] = await db
		.insert(users)
		.values({ email: 'board@example.com', displayName: 'B', passwordHash: 'x', role: 'user' })
		.returning();
	ownerId = owner.id;
	const [stranger] = await db
		.insert(users)
		.values({ email: 'board2@example.com', displayName: 'B2', passwordHash: 'x', role: 'user' })
		.returning();
	strangerId = stranger.id;
	const [universe] = await db.insert(universes).values({ ownerId, name: 'U' }).returning();
	const [story] = await db
		.insert(stories)
		.values({ universeId: universe.id, ownerId, title: 'S' })
		.returning();
	const [scene] = await db
		.insert(scenes)
		.values({ storyId: story.id, globalPosition: 1 })
		.returning();
	sceneId = scene.id;
});

afterAll(async () => {
	await pool.end();
});

async function currentStatus() {
	const [row] = await db
		.select({ status: scenes.status })
		.from(scenes)
		.where(eq(scenes.id, sceneId));
	return row.status;
}

describe('setSceneStatus', () => {
	it('moves the scene along the ladder', async () => {
		expect(await currentStatus()).toBe('draft');
		expect(await setSceneStatus(db, ownerId, sceneId, 'revised')).toBe(true);
		expect(await currentStatus()).toBe('revised');
	});

	it('a stranger cannot touch it', async () => {
		expect(await setSceneStatus(db, strangerId, sceneId, 'final')).toBe(false);
		expect(await currentStatus()).toBe('revised');
	});

	it('an unknown scene reports not found', async () => {
		expect(await setSceneStatus(db, ownerId, '00000000-0000-0000-0000-000000000000', 'final')).toBe(
			false
		);
	});
});
