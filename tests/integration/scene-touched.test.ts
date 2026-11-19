import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { chapters, scenes, stories, universes, users } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase } from './test-db';

// The home page loader imports the app's db; point it at the test database.
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
const dashboard = await import('../../src/routes/+page.server');
const { lastTouchedScene } = await import('../../src/lib/server/scene-access');
const { setSceneStatus } = await import('../../src/lib/server/scene-status');
const { trashScene, restoreScene, deleteChapter } =
	await import('../../src/lib/server/scene-lifecycle');
const { applySceneOrder } = await import('../../src/lib/server/scene-order');
const { duplicateScene, splitScene } = await import('../../src/lib/server/scene-split-merge');

let ownerId: string;
let storyId: string;
let chapterId: string;
let firstId: string;
let secondId: string;

const LONG_AGO = new Date('2026-01-01T00:00:00Z');

async function editedAt(): Promise<string> {
	const url = new URL('http://localhost/');
	const data = (await dashboard.load({
		url,
		locals: { user: { id: ownerId, displayName: 'O' }, session: null },
		cookies: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), getAll: vi.fn(() => []) }
	} as never)) as { stories: { id: string; editedAt: string }[] };
	return data.stories.find((s) => s.id === storyId)!.editedAt;
}

beforeAll(async () => {
	await ensureTestDatabase();
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query('truncate table users cascade');
	const [owner] = await db
		.insert(users)
		.values({ email: 'touch@example.com', displayName: 'O', passwordHash: 'x', role: 'user' })
		.returning();
	ownerId = owner.id;
	const [universe] = await db.insert(universes).values({ ownerId, name: 'Fen' }).returning();
	const [story] = await db
		.insert(stories)
		.values({ universeId: universe.id, ownerId, title: 'Reeds', updatedAt: LONG_AGO })
		.returning();
	storyId = story.id;
	const [chapter] = await db.insert(chapters).values({ storyId, position: 1 }).returning();
	chapterId = chapter.id;
	const rows = await db
		.insert(scenes)
		.values([
			{ storyId, chapterId, positionInChapter: 1, globalPosition: 1, bodyMd: 'One.' },
			{ storyId, chapterId, positionInChapter: 2, globalPosition: 2, bodyMd: 'Two.' }
		])
		.returning({ id: scenes.id });
	[firstId, secondId] = rows.map((r) => r.id);
	// Both last changed long ago, the first more recently, so it opens by default.
	await pool.query('update scenes set touched_at = $1, updated_at = $1 where id = $2', [
		new Date('2026-01-02T00:00:00Z'),
		secondId
	]);
	await pool.query('update scenes set touched_at = $1, updated_at = $1 where id = $2', [
		new Date('2026-01-03T00:00:00Z'),
		firstId
	]);
});

describe('scene touched_at', () => {
	it('moves the story card and the default scene on a status change, but not updated_at', async () => {
		expect(new Date(await editedAt()).toISOString()).toBe('2026-01-03T00:00:00.000Z');
		expect((await lastTouchedScene(db, storyId))?.id).toBe(firstId);

		expect(await setSceneStatus(db, ownerId, secondId, 'revised')).toBe(true);

		expect(new Date(await editedAt()).getTime()).toBeGreaterThan(Date.parse('2026-02-01'));
		expect((await lastTouchedScene(db, storyId))?.id).toBe(secondId);
		const [row] = await db
			.select({ updatedAt: scenes.updatedAt })
			.from(scenes)
			.where(eq(scenes.id, secondId));
		expect(row.updatedAt.toISOString()).toBe('2026-01-02T00:00:00.000Z');
	});

	it('reads a scene with no touched_at by its updated_at', async () => {
		// Scenes from before the column existed have no touched_at.
		await pool.query('update scenes set touched_at = null where id = $1', [secondId]);
		expect((await lastTouchedScene(db, storyId))?.id).toBe(firstId);
		await pool.query('update scenes set updated_at = $1 where id = $2', [
			new Date('2026-01-04T00:00:00Z'),
			secondId
		]);
		expect((await lastTouchedScene(db, storyId))?.id).toBe(secondId);
		expect(new Date(await editedAt()).toISOString()).toBe('2026-01-04T00:00:00.000Z');
	});

	it('counts the trash and a restore as a change', async () => {
		expect(await trashScene(db, ownerId, secondId)).toBe(true);
		expect(await restoreScene(db, ownerId, secondId)).toBe(true);
		expect((await lastTouchedScene(db, storyId))?.id).toBe(secondId);
	});

	it('counts a move, and leaves scenes the reorder did not move alone', async () => {
		const [third] = await db
			.insert(scenes)
			.values({ storyId, chapterId, positionInChapter: 3, globalPosition: 3, bodyMd: 'Three.' })
			.returning({ id: scenes.id });
		await pool.query('update scenes set touched_at = $1 where id = $2', [LONG_AGO, third.id]);
		// Swap the first two; the third stays where it was.
		const result = await applySceneOrder(db, storyId, {
			chapters: [{ id: chapterId, sceneIds: [secondId, firstId, third.id] }],
			orphanSceneIds: []
		});
		expect(result.ok).toBe(true);
		const [moved] = await db
			.select({ touchedAt: scenes.touchedAt })
			.from(scenes)
			.where(eq(scenes.id, secondId));
		expect(moved.touchedAt!.getTime()).toBeGreaterThan(Date.parse('2026-02-01'));
		const [kept] = await db
			.select({ touchedAt: scenes.touchedAt })
			.from(scenes)
			.where(eq(scenes.id, third.id));
		expect(kept.touchedAt!.toISOString()).toBe(LONG_AGO.toISOString());
	});

	it('touches only the scene the writer moved, not the ones it shifted', async () => {
		const [third] = await db
			.insert(scenes)
			.values({ storyId, chapterId, positionInChapter: 3, globalPosition: 3, bodyMd: 'Three.' })
			.returning({ id: scenes.id });
		await pool.query('update scenes set touched_at = $1 where id = $2', [LONG_AGO, third.id]);
		// The third scene moves to the front; the other two shift down one.
		const result = await applySceneOrder(db, storyId, {
			chapters: [{ id: chapterId, sceneIds: [third.id, firstId, secondId] }],
			orphanSceneIds: []
		});
		expect(result.ok).toBe(true);
		expect((await lastTouchedScene(db, storyId))?.id).toBe(third.id);
		expect(await touchedAt(firstId)).toBe('2026-01-03T00:00:00.000Z');
		expect(await touchedAt(secondId)).toBe('2026-01-02T00:00:00.000Z');
	});

	it('does not touch the scenes a split or a duplicate shifts along', async () => {
		// The second scene sits after the first, so both operations on the
		// first shift it down one place.
		await pool.query('update scenes set body_md = $1 where id = $2', ['One. More.', firstId]);
		expect(await splitScene(db, ownerId, firstId, 'One. '.length)).toMatchObject({ ok: true });
		expect(await duplicateScene(db, ownerId, firstId)).toMatchObject({ ok: true });
		expect(await touchedAt(secondId)).toBe('2026-01-02T00:00:00.000Z');
	});

	it('does not touch the scenes of a deleted chapter', async () => {
		expect(await deleteChapter(db, ownerId, chapterId)).toBe(true);
		expect(await touchedAt(firstId)).toBe('2026-01-03T00:00:00.000Z');
		expect(await touchedAt(secondId)).toBe('2026-01-02T00:00:00.000Z');
	});
});

async function touchedAt(id: string): Promise<string | undefined> {
	const [row] = await db
		.select({ touchedAt: scenes.touchedAt })
		.from(scenes)
		.where(eq(scenes.id, id));
	return row.touchedAt?.toISOString();
}
