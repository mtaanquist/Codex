import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, desc, eq } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	revisions,
	sceneMarkers,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import {
	createMarker,
	deleteMarker,
	listSceneMarkers,
	listStoryTodos,
	setMarkerResolved,
	updateMarkerAnchors
} from '../../src/lib/server/markers';
import { saveSceneBody } from '../../src/lib/server/scene-save';
import { recordRevision, restoreRevision } from '../../src/lib/server/revisions';
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
	await pool.query(
		'truncate table scene_markers, revisions, scenes, stories, universes, users cascade'
	);

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
			code: 'not_found'
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

	it('slices un-noted snippets and skips scenes with nothing to do', async () => {
		// No "TODO:" in this body, so only the un-noted marker can make it
		// come back. Astral characters ahead of the anchor: UTF-16 offsets
		// must still land.
		const body = 'A \u{1F409} dragon wakes.';
		const [quiet] = await db
			.insert(scenes)
			.values({ storyId, globalPosition: 10, title: 'Quiet', bodyMd: 'Nothing left here.' })
			.returning();
		const [marked] = await db
			.insert(scenes)
			.values({ storyId, globalPosition: 11, title: 'Dragon', bodyMd: body })
			.returning();
		const [midLine] = await db
			.insert(scenes)
			.values({
				storyId,
				globalPosition: 12,
				title: 'Aside',
				bodyMd: 'She said TODO: not a marker'
			})
			.returning();
		const start = body.indexOf('dragon');
		const plain = await createMarker(db, ownerId, marked.id, start, start + 6);
		const noted = await createMarker(db, ownerId, quiet.id, 0, 7, 'tighten');
		if (!plain.ok || !noted.ok) throw new Error('setup failed');

		const todos = await listStoryTodos(db, storyId);
		expect(todos.filter((todo) => todo.sceneId === marked.id)).toEqual([
			{ sceneId: marked.id, sceneTitle: 'Dragon', markerId: plain.id, text: 'dragon' }
		]);
		expect(todos.filter((todo) => todo.sceneId === quiet.id)).toEqual([
			{ sceneId: quiet.id, sceneTitle: 'Quiet', markerId: noted.id, text: 'tighten' }
		]);
		expect(todos.filter((todo) => todo.sceneId === midLine.id)).toEqual([]);

		await deleteMarker(db, ownerId, plain.id);
		await deleteMarker(db, ownerId, noted.id);
		await db.delete(scenes).where(eq(scenes.id, quiet.id));
		await db.delete(scenes).where(eq(scenes.id, marked.id));
		await db.delete(scenes).where(eq(scenes.id, midLine.id));
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

		await updateMarkerAnchors(
			db,
			sceneId,
			[
				{ id: marker.id, anchorStart: 10, anchorEnd: 15 },
				{ id: foreign.id, anchorStart: 0, anchorEnd: 1 }
			],
			BODY.length
		);
		const [moved] = await db.select().from(sceneMarkers).where(eq(sceneMarkers.id, marker.id));
		expect([moved.anchorStart, moved.anchorEnd]).toEqual([10, 15]);
		const [untouched] = await db.select().from(sceneMarkers).where(eq(sceneMarkers.id, foreign.id));
		expect([untouched.anchorStart, untouched.anchorEnd]).toEqual([0, 4]);
	});

	it('clamps out-of-range anchors to the body on save', async () => {
		const created = await createMarker(db, ownerId, sceneId, 0, 5);
		if (!created.ok) throw new Error('setup failed');
		await updateMarkerAnchors(
			db,
			sceneId,
			[{ id: created.id, anchorStart: -5, anchorEnd: 9999 }],
			BODY.length
		);
		const [row] = await db.select().from(sceneMarkers).where(eq(sceneMarkers.id, created.id));
		expect(row.anchorStart).toBe(0);
		expect(row.anchorEnd).toBe(BODY.length);
	});

	it('deletes own markers only', async () => {
		const created = await createMarker(db, ownerId, sceneId, 0, 3);
		if (!created.ok) throw new Error('setup failed');
		expect(await deleteMarker(db, strangerId, created.id)).toBe(false);
		expect(await deleteMarker(db, ownerId, created.id)).toBe(true);
	});
});

// Body rewrites that do not come from the Write editor carry no anchors;
// the stored ones must follow the text rather than keep their old offsets.
describe('anchors follow body rewrites outside the Write editor', () => {
	const TEXT = 'The bridge creaks. Alice pays the toll. She rides on.';

	async function markedScene(phrase: string) {
		const [scene] = await db
			.insert(scenes)
			.values({ storyId, globalPosition: 10, bodyMd: TEXT })
			.returning();
		const start = TEXT.indexOf(phrase);
		const marker = await createMarker(db, ownerId, scene.id, start, start + phrase.length);
		if (!marker.ok) throw new Error('setup failed');
		return { sceneId: scene.id, markerId: marker.id };
	}

	async function anchors(markerId: string) {
		const [row] = await db.select().from(sceneMarkers).where(eq(sceneMarkers.id, markerId));
		return [row.anchorStart, row.anchorEnd];
	}

	function quote(body: string, range: (number | null)[]) {
		return body.slice(range[0]!, range[1]!);
	}

	it('a save without markers maps them through the edit', async () => {
		const { sceneId: id, markerId } = await markedScene('pays the toll');
		const edited = 'A new opening line.\n\n' + TEXT;
		const result = await saveSceneBody(db, id, {
			title: null,
			bodyMd: edited,
			anchors: null,
			baseHashes: null,
			overwrite: false
		});
		expect(result.ok).toBe(true);
		expect(quote(edited, await anchors(markerId))).toBe('pays the toll');
	});

	it('a save without markers drops the anchor when its text is gone', async () => {
		const { sceneId: id, markerId } = await markedScene('pays the toll');
		await saveSceneBody(db, id, {
			title: null,
			bodyMd: 'The bridge creaks. She rides on.',
			anchors: null,
			baseHashes: null,
			overwrite: false
		});
		expect(await anchors(markerId)).toEqual([null, null]);
	});

	it('restoring a revision maps anchors onto the restored text', async () => {
		const { sceneId: id, markerId } = await markedScene('She rides on');
		const older = 'Long before: ' + TEXT;
		await recordRevision(db, 'scene', id, older, 'checkpoint');
		const [revision] = await db
			.select({ id: revisions.id })
			.from(revisions)
			.where(and(eq(revisions.entityType, 'scene'), eq(revisions.entityId, id)))
			.orderBy(desc(revisions.createdAt))
			.limit(1);
		expect(await restoreRevision(db, ownerId, revision.id, 'scene', id)).toMatchObject({
			ok: true
		});
		expect(quote(older, await anchors(markerId))).toBe('She rides on');
	});
});
