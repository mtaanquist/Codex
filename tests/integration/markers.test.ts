import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { sceneMarkers, scenes, stories, universes, users } from '../../src/lib/server/db/schema';
import {
	createMarker,
	deleteMarker,
	listSceneMarkers,
	listStoryTodos,
	setMarkerResolved,
	updateMarkerAnchors
} from '../../src/lib/server/markers';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let strangerId: string;
let storyId: string;
let sceneId: string;

const BODY = 'Alice pays the toll.\nTODO: sharpen this exchange\nShe rides on.';

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
	await pool.query('truncate table scene_markers, scenes, stories, universes, users cascade');

	const [owner] = await db
		.insert(users)
		.values({ email: 'mark@example.com', displayName: 'Mark', passwordHash: 'x', role: 'user' })
		.returning();
	ownerId = owner.id;
	const [stranger] = await db
		.insert(users)
		.values({ email: 'mark2@example.com', displayName: 'Mark2', passwordHash: 'x', role: 'user' })
		.returning();
	strangerId = stranger.id;
	const [universe] = await db.insert(universes).values({ ownerId, name: 'U' }).returning();
	const [story] = await db
		.insert(stories)
		.values({ universeId: universe.id, ownerId, title: 'S' })
		.returning();
	storyId = story.id;
	const [scene] = await db
		.insert(scenes)
		.values({ storyId, globalPosition: 1, title: 'Toll', bodyMd: BODY })
		.returning();
	sceneId = scene.id;
});

afterAll(async () => {
	await pool.end();
});

describe('createMarker', () => {
	it('creates from a selection, clamping anchors to the body', async () => {
		const result = await createMarker(db, ownerId, sceneId, 0, 5);
		expect(result).toMatchObject({ ok: true });
		const clamped = await createMarker(db, ownerId, sceneId, 6, 9999, 'check this');
		expect(clamped).toMatchObject({ ok: true });
		const markers = await listSceneMarkers(db, sceneId);
		expect(markers).toHaveLength(2);
		expect(markers[1].anchorEnd).toBe(BODY.length);
	});

	it('rejects an empty selection and a foreign scene', async () => {
		expect(await createMarker(db, ownerId, sceneId, 3, 3)).toMatchObject({ ok: false });
		expect(await createMarker(db, strangerId, sceneId, 0, 5)).toMatchObject({
			ok: false,
			reason: 'scene not found'
		});
	});
});

describe('listStoryTodos', () => {
	it('lists markers and TODO: lines in scene order', async () => {
		const todos = await listStoryTodos(db, storyId);
		// Two markers plus one text TODO.
		expect(todos).toHaveLength(3);
		const textTodo = todos.find((todo) => todo.markerId === null);
		expect(textTodo).toMatchObject({ sceneTitle: 'Toll', text: 'sharpen this exchange' });
		const noted = todos.find((todo) => todo.text === 'check this');
		expect(noted?.markerId).not.toBeNull();
		// A marker without a note falls back to the selected text.
		expect(todos.some((todo) => todo.text === 'Alice')).toBe(true);
	});
});

describe('resolve and anchors', () => {
	it('checking off hides a marker from the lists; unchecking brings it back', async () => {
		const [marker] = await listSceneMarkers(db, sceneId);
		expect(await setMarkerResolved(db, strangerId, marker.id, true)).toBe(false);
		expect(await setMarkerResolved(db, ownerId, marker.id, true)).toBe(true);
		expect((await listSceneMarkers(db, sceneId)).map((m) => m.id)).not.toContain(marker.id);
		expect(await setMarkerResolved(db, ownerId, marker.id, false)).toBe(true);
		expect((await listSceneMarkers(db, sceneId)).map((m) => m.id)).toContain(marker.id);
	});

	it('moves anchors and ignores ids from other scenes', async () => {
		const [marker] = await listSceneMarkers(db, sceneId);
		const [otherScene] = await db
			.insert(scenes)
			.values({ storyId, globalPosition: 2, bodyMd: 'Elsewhere.' })
			.returning();
		const foreign = await createMarker(db, ownerId, otherScene.id, 0, 4);
		if (!foreign.ok) throw new Error('setup failed');

		await updateMarkerAnchors(db, sceneId, [
			{ id: marker.id, anchorStart: 10, anchorEnd: 15 },
			{ id: foreign.id, anchorStart: 0, anchorEnd: 1 }
		]);
		const [moved] = await db.select().from(sceneMarkers).where(eq(sceneMarkers.id, marker.id));
		expect([moved.anchorStart, moved.anchorEnd]).toEqual([10, 15]);
		const [untouched] = await db.select().from(sceneMarkers).where(eq(sceneMarkers.id, foreign.id));
		expect([untouched.anchorStart, untouched.anchorEnd]).toEqual([0, 4]);
	});

	it('deletes own markers only', async () => {
		const created = await createMarker(db, ownerId, sceneId, 0, 3);
		if (!created.ok) throw new Error('setup failed');
		expect(await deleteMarker(db, strangerId, created.id)).toBe(false);
		expect(await deleteMarker(db, ownerId, created.id)).toBe(true);
	});
});
