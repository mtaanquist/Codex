import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, asc, eq, isNull } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { sceneMarkers, scenes, stories, universes, users } from '../../src/lib/server/db/schema';
import { mergeScenes, splitScene } from '../../src/lib/server/scene-split-merge';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let strangerId: string;
let storyId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
	await pool.query('truncate table scene_markers, scenes, stories, universes, users cascade');

	const [owner] = await db
		.insert(users)
		.values({ email: 'cut@example.com', displayName: 'C', passwordHash: 'x', role: 'user' })
		.returning();
	ownerId = owner.id;
	const [stranger] = await db
		.insert(users)
		.values({ email: 'not-cut@example.com', displayName: 'N', passwordHash: 'x', role: 'user' })
		.returning();
	strangerId = stranger.id;
	const [universe] = await db.insert(universes).values({ ownerId, name: 'U' }).returning();
	const [story] = await db
		.insert(stories)
		.values({ universeId: universe.id, ownerId, title: 'S' })
		.returning();
	storyId = story.id;
});

beforeEach(async () => {
	await pool.query('truncate table scene_markers, scenes cascade');
});

afterAll(async () => {
	await pool.end();
});

async function makeScene(globalPosition: number, bodyMd: string, title: string | null = null) {
	const [scene] = await db
		.insert(scenes)
		.values({ storyId, globalPosition, bodyMd, title })
		.returning();
	return scene;
}

describe('splitScene', () => {
	it('moves the text after the cut into a new scene directly after', async () => {
		const before = await makeScene(1, 'Stays put.');
		const scene = await makeScene(2, 'First half stays. Second half moves.', 'The night');
		const after = await makeScene(3, 'Also stays put.');

		const cut = 'First half stays. '.length;
		const result = await splitScene(db, ownerId, scene.id, cut);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const rows = await db
			.select()
			.from(scenes)
			.where(and(eq(scenes.storyId, storyId), isNull(scenes.deletedAt)))
			.orderBy(asc(scenes.globalPosition));
		expect(rows.map((row) => row.bodyMd)).toEqual([
			'Stays put.',
			'First half stays.',
			'Second half moves.',
			'Also stays put.'
		]);
		const created = rows[2];
		expect(created.id).toBe(result.newSceneId);
		expect(created.title).toBeNull();
		expect(created.status).toBe(scene.status);
		expect(created.wordCount).toBe(3);
		expect(rows[1].wordCount).toBe(3);
		// The scenes around the cut kept their order.
		expect(rows[0].id).toBe(before.id);
		expect(rows[3].id).toBe(after.id);
	});

	it('moves markers with their text and clamps one straddling the cut', async () => {
		const body = 'Alpha beta. Gamma delta.';
		const scene = await makeScene(1, body, null);
		const cut = 'Alpha beta. '.length;
		const inHead = { anchorStart: 0, anchorEnd: 5 };
		const inTail = { anchorStart: cut, anchorEnd: cut + 5 };
		const straddling = { anchorStart: 6, anchorEnd: cut + 5 };
		for (const anchors of [inHead, inTail, straddling]) {
			await db.insert(sceneMarkers).values({ sceneId: scene.id, ownerId, ...anchors });
		}

		const result = await splitScene(db, ownerId, scene.id, cut);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const headMarkers = await db
			.select()
			.from(sceneMarkers)
			.where(eq(sceneMarkers.sceneId, scene.id))
			.orderBy(asc(sceneMarkers.anchorStart));
		const tailMarkers = await db
			.select()
			.from(sceneMarkers)
			.where(eq(sceneMarkers.sceneId, result.newSceneId));
		expect(headMarkers).toHaveLength(2);
		// The straddler is clamped to the trimmed first half ('Alpha beta.').
		expect(headMarkers[1]).toMatchObject({ anchorStart: 6, anchorEnd: 'Alpha beta.'.length });
		expect(tailMarkers).toHaveLength(1);
		// 'Gamma' starts the new scene once the seam whitespace is shed.
		expect(tailMarkers[0]).toMatchObject({ anchorStart: 0, anchorEnd: 5 });
	});

	it('refuses an edge cut, a foreign scene, and a missing scene', async () => {
		const scene = await makeScene(1, 'Some text.');
		expect(await splitScene(db, ownerId, scene.id, 0)).toMatchObject({ ok: false });
		expect(await splitScene(db, ownerId, scene.id, 'Some text.'.length)).toMatchObject({
			ok: false
		});
		expect(await splitScene(db, strangerId, scene.id, 4)).toMatchObject({ ok: false });
		expect(await splitScene(db, ownerId, '00000000-0000-4000-8000-000000000000', 4)).toMatchObject({
			ok: false
		});
	});
});

describe('mergeScenes', () => {
	it('joins scenes in story order into the earliest, trashing the rest', async () => {
		const a = await makeScene(1, 'One.', 'Opening');
		const b = await makeScene(2, 'Two.\n');
		const c = await makeScene(3, 'Three.');

		// Picked out of order; the merge still reads 1-2-3.
		const result = await mergeScenes(db, ownerId, storyId, [c.id, a.id, b.id]);
		expect(result).toMatchObject({ ok: true, targetSceneId: a.id });

		const [target] = await db.select().from(scenes).where(eq(scenes.id, a.id));
		expect(target.bodyMd).toBe('One.\n\nTwo.\n\nThree.');
		expect(target.title).toBe('Opening');
		expect(target.wordCount).toBe(3);

		const trashed = await db
			.select()
			.from(scenes)
			.where(and(eq(scenes.storyId, storyId), isNull(scenes.deletedAt)));
		expect(trashed).toHaveLength(1);
	});

	it('moves markers along with each merged body', async () => {
		const a = await makeScene(1, 'One.');
		const b = await makeScene(2, 'Two two.');
		await db.insert(sceneMarkers).values({ sceneId: b.id, ownerId, anchorStart: 4, anchorEnd: 8 });

		const result = await mergeScenes(db, ownerId, storyId, [a.id, b.id]);
		expect(result.ok).toBe(true);

		const markers = await db.select().from(sceneMarkers).where(eq(sceneMarkers.sceneId, a.id));
		expect(markers).toHaveLength(1);
		// 'One.' + blank line puts b's text at offset 6.
		expect(markers[0]).toMatchObject({ anchorStart: 10, anchorEnd: 14 });
	});

	it('refuses fewer than two scenes, foreign scenes, and cross-story mixes', async () => {
		const a = await makeScene(1, 'One.');
		const b = await makeScene(2, 'Two.');
		expect(await mergeScenes(db, ownerId, storyId, [a.id])).toMatchObject({ ok: false });
		expect(await mergeScenes(db, strangerId, storyId, [a.id, b.id])).toMatchObject({ ok: false });

		// A scene from another story cannot ride along.
		const [story] = await db.select().from(stories).where(eq(stories.id, storyId));
		const [otherStory] = await db
			.insert(stories)
			.values({ universeId: story.universeId, ownerId, title: 'O' })
			.returning();
		const [foreign] = await db
			.insert(scenes)
			.values({ storyId: otherStory.id, globalPosition: 1, bodyMd: 'Elsewhere.' })
			.returning();
		expect(await mergeScenes(db, ownerId, storyId, [a.id, foreign.id])).toMatchObject({
			ok: false
		});
	});
});
