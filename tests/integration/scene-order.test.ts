import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { asc, eq } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { chapters, scenes, stories, universes, users } from '../../src/lib/server/db/schema';
import { applySceneOrder } from '../../src/lib/server/scene-order';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let storyId: string;
let chapterA: string;
let chapterB: string;
let s1: string;
let s2: string;
let s3: string;

async function positions() {
	return await db
		.select({
			id: scenes.id,
			chapterId: scenes.chapterId,
			positionInChapter: scenes.positionInChapter,
			globalPosition: scenes.globalPosition
		})
		.from(scenes)
		.where(eq(scenes.storyId, storyId))
		.orderBy(asc(scenes.globalPosition));
}

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
	await pool.query('truncate table scenes, chapters, stories, universes, users cascade');

	const [user] = await db
		.insert(users)
		.values({
			email: 'order@example.com',
			displayName: 'Order',
			passwordHash: 'x',
			role: 'user'
		})
		.returning();
	const [universe] = await db.insert(universes).values({ ownerId: user.id, name: 'U' }).returning();
	const [story] = await db
		.insert(stories)
		.values({ universeId: universe.id, ownerId: user.id, title: 'S' })
		.returning();
	storyId = story.id;
	const [a] = await db.insert(chapters).values({ storyId, position: 1, title: 'A' }).returning();
	const [b] = await db.insert(chapters).values({ storyId, position: 2, title: 'B' }).returning();
	chapterA = a.id;
	chapterB = b.id;
	const rows = await db
		.insert(scenes)
		.values([
			{ storyId, chapterId: chapterA, positionInChapter: 1, globalPosition: 1, title: 's1' },
			{ storyId, chapterId: chapterA, positionInChapter: 2, globalPosition: 2, title: 's2' },
			{ storyId, chapterId: chapterB, positionInChapter: 1, globalPosition: 3, title: 's3' }
		])
		.returning();
	[s1, s2, s3] = rows.map((row) => row.id);
});

afterAll(async () => {
	await pool.end();
});

describe('applySceneOrder', () => {
	it('moves a scene across chapters and renumbers everything', async () => {
		const result = await applySceneOrder(db, storyId, {
			chapters: [
				{ id: chapterA, sceneIds: [s2] },
				{ id: chapterB, sceneIds: [s3, s1] }
			],
			orphanSceneIds: []
		});
		expect(result.ok).toBe(true);

		const rows = await positions();
		expect(rows.map((row) => row.id)).toEqual([s2, s3, s1]);
		expect(rows.map((row) => row.globalPosition)).toEqual([1, 2, 3]);
		expect(rows.find((row) => row.id === s1)).toMatchObject({
			chapterId: chapterB,
			positionInChapter: 2
		});
	});

	it('moves a scene to the orphan list', async () => {
		const result = await applySceneOrder(db, storyId, {
			chapters: [
				{ id: chapterA, sceneIds: [s2] },
				{ id: chapterB, sceneIds: [s3] }
			],
			orphanSceneIds: [s1]
		});
		expect(result.ok).toBe(true);
		const rows = await positions();
		expect(rows.find((row) => row.id === s1)).toMatchObject({
			chapterId: null,
			positionInChapter: null,
			globalPosition: 3
		});
	});

	it('rejects an order that drops a scene', async () => {
		const result = await applySceneOrder(db, storyId, {
			chapters: [
				{ id: chapterA, sceneIds: [s2] },
				{ id: chapterB, sceneIds: [s3] }
			],
			orphanSceneIds: []
		});
		expect(result).toMatchObject({ ok: false });
	});

	it('rejects an order that lists a scene twice', async () => {
		const result = await applySceneOrder(db, storyId, {
			chapters: [
				{ id: chapterA, sceneIds: [s2, s1] },
				{ id: chapterB, sceneIds: [s3, s1] }
			],
			orphanSceneIds: []
		});
		expect(result).toMatchObject({ ok: false });
	});

	it('rejects an order with a foreign chapter', async () => {
		const result = await applySceneOrder(db, storyId, {
			chapters: [{ id: crypto.randomUUID(), sceneIds: [s1, s2, s3] }],
			orphanSceneIds: []
		});
		expect(result).toMatchObject({ ok: false });
	});
});
