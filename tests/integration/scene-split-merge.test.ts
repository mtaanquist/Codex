import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, asc, eq, isNull } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { sceneMarkers, scenes, stories, universes, users } from '../../src/lib/server/db/schema';
import {
	duplicateScene,
	locateSplitInStory,
	mergeScenes,
	splitScene
} from '../../src/lib/server/scene-split-merge';
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

	it('sheds the seam whitespace whichever side of a paragraph break the cut lands', async () => {
		// A cut at either edge of the blank line between paragraphs must leave
		// the first scene with no trailing blank and the new scene opening with
		// its text, not an empty line.
		const body = 'First paragraph ends here.\n\nSecond paragraph starts here.';
		for (const offset of ['First paragraph ends here.'.length, body.indexOf('Second paragraph')]) {
			const scene = await makeScene(1, body);
			const result = await splitScene(db, ownerId, scene.id, offset);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			const [head] = await db.select().from(scenes).where(eq(scenes.id, scene.id));
			const [tail] = await db.select().from(scenes).where(eq(scenes.id, result.newSceneId));
			expect(head.bodyMd).toBe('First paragraph ends here.');
			expect(tail.bodyMd).toBe('Second paragraph starts here.');
			await pool.query('truncate table scene_markers, scenes cascade');
		}
	});
});

describe('duplicateScene', () => {
	it('copies the scene in full directly after the original', async () => {
		const before = await makeScene(1, 'Stays first.');
		const scene = await makeScene(2, 'Template body.', 'Session skeleton');
		await db
			.update(scenes)
			.set({ status: 'outline', summaryMd: 'A recurring shape', storyTime: 'Day 1' })
			.where(eq(scenes.id, scene.id));
		const after = await makeScene(3, 'Stays last.');

		const result = await duplicateScene(db, ownerId, scene.id);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const rows = await db
			.select()
			.from(scenes)
			.where(and(eq(scenes.storyId, storyId), isNull(scenes.deletedAt)))
			.orderBy(asc(scenes.globalPosition));
		expect(rows.map((row) => row.bodyMd)).toEqual([
			'Stays first.',
			'Template body.',
			'Template body.',
			'Stays last.'
		]);
		// The copy lands directly after its source, between it and the next scene.
		expect(rows[0].id).toBe(before.id);
		expect(rows[1].id).toBe(scene.id);
		expect(rows[3].id).toBe(after.id);

		const copy = rows[2];
		expect(copy.id).toBe(result.newSceneId);
		expect(copy.title).toBe('Session skeleton (copy)');
		expect(copy.status).toBe('outline');
		expect(copy.summaryMd).toBe('A recurring shape');
		expect(copy.storyTime).toBe('Day 1');
		expect(copy.wordCount).toBe(2);
		// The source is untouched.
		const [original] = await db.select().from(scenes).where(eq(scenes.id, scene.id));
		expect(original.title).toBe('Session skeleton');
		expect(original.bodyMd).toBe('Template body.');
	});

	it('copies markers onto the new scene at the same anchors', async () => {
		const scene = await makeScene(1, 'Alpha beta gamma.', 'With markers');
		await db
			.insert(sceneMarkers)
			.values({ sceneId: scene.id, ownerId, kind: 'todo', anchorStart: 0, anchorEnd: 5 });

		const result = await duplicateScene(db, ownerId, scene.id);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const copyMarkers = await db
			.select()
			.from(sceneMarkers)
			.where(eq(sceneMarkers.sceneId, result.newSceneId));
		expect(copyMarkers).toHaveLength(1);
		expect(copyMarkers[0]).toMatchObject({ kind: 'todo', anchorStart: 0, anchorEnd: 5 });
		// The original's marker stays its own row.
		const sourceMarkers = await db
			.select()
			.from(sceneMarkers)
			.where(eq(sceneMarkers.sceneId, scene.id));
		expect(sourceMarkers).toHaveLength(1);
		expect(sourceMarkers[0].id).not.toBe(copyMarkers[0].id);
	});

	it('keeps an untitled scene untitled when copied', async () => {
		const scene = await makeScene(1, 'No name.', null);
		const result = await duplicateScene(db, ownerId, scene.id);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const [copy] = await db.select().from(scenes).where(eq(scenes.id, result.newSceneId));
		expect(copy.title).toBeNull();
	});

	it('refuses a foreign scene and a missing scene', async () => {
		const scene = await makeScene(1, 'Mine.');
		expect(await duplicateScene(db, strangerId, scene.id)).toMatchObject({ ok: false });
		expect(await duplicateScene(db, ownerId, '00000000-0000-4000-8000-000000000000')).toMatchObject(
			{ ok: false }
		);
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

	it('moves an unanchored marker to the target with its anchors still null', async () => {
		const a = await makeScene(1, 'One.');
		const b = await makeScene(2, 'Two two.');
		await db
			.insert(sceneMarkers)
			.values({ sceneId: b.id, ownerId, anchorStart: null, anchorEnd: null });

		const result = await mergeScenes(db, ownerId, storyId, [a.id, b.id]);
		expect(result.ok).toBe(true);

		const markers = await db.select().from(sceneMarkers).where(eq(sceneMarkers.sceneId, a.id));
		expect(markers).toHaveLength(1);
		// An unanchored marker must not come out pinned at the merge seam.
		expect(markers[0]).toMatchObject({ anchorStart: null, anchorEnd: null });
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

// The Assistant's split proposals anchor to the scene they were made against,
// but a confirmed earlier split moves the later passages into the new scene.
// The passage, not the scene id, is what the author confirmed, so the locate
// follows it to whichever live scene of the story holds it now.
describe('locateSplitInStory', () => {
	const BODY = 'Opening beat. MIDCUT second beat. LATECUT third beat.';

	it('locates in the proposed scene when the passage is still there', async () => {
		const scene = await makeScene(1, BODY);
		expect(await locateSplitInStory(db, ownerId, scene.id, 'MIDCUT')).toEqual({
			ok: true,
			sceneId: scene.id,
			offset: BODY.indexOf('MIDCUT')
		});
	});

	it('follows the passage into the scene a confirmed earlier split moved it to', async () => {
		// The model proposes two splits of one scene; the author confirms the
		// first, which moves the second split point into the new scene.
		const scene = await makeScene(1, BODY);
		const first = await splitScene(db, ownerId, scene.id, BODY.indexOf('MIDCUT'));
		expect(first.ok).toBe(true);
		if (!first.ok) return;

		const located = await locateSplitInStory(db, ownerId, scene.id, 'LATECUT');
		expect(located).toMatchObject({ ok: true, sceneId: first.newSceneId });
		if (!located.ok) return;

		// Confirming the second proposal completes the three-way split.
		const second = await splitScene(db, ownerId, located.sceneId, located.offset);
		expect(second.ok).toBe(true);
		const rows = await db
			.select({ bodyMd: scenes.bodyMd })
			.from(scenes)
			.where(and(eq(scenes.storyId, storyId), isNull(scenes.deletedAt)))
			.orderBy(asc(scenes.globalPosition));
		expect(rows.map((r) => r.bodyMd)).toEqual([
			'Opening beat.',
			'MIDCUT second beat.',
			'LATECUT third beat.'
		]);
	});

	it('keeps the not-found reason when no scene holds the passage', async () => {
		const scene = await makeScene(1, BODY);
		await makeScene(2, 'Another scene entirely.');
		expect(await locateSplitInStory(db, ownerId, scene.id, 'NOSUCHCUT')).toMatchObject({
			ok: false,
			reason: 'That exact text was not found in the scene.'
		});
	});

	it('refuses a passage that more than one scene holds', async () => {
		const scene = await makeScene(1, 'Original text without the cut.');
		await makeScene(2, 'A TWICECUT here.');
		await makeScene(3, 'And TWICECUT here too.');
		expect(await locateSplitInStory(db, ownerId, scene.id, 'TWICECUT')).toMatchObject({
			ok: false,
			reason:
				'That text appears in more than one scene; include more surrounding text to make it unique.'
		});
	});

	it('keeps the duplicate reason when the proposed scene holds the passage twice', async () => {
		const scene = await makeScene(1, 'A DOUBLE beat and a DOUBLE echo.');
		await makeScene(2, 'A DOUBLE elsewhere too.');
		const located = await locateSplitInStory(db, ownerId, scene.id, 'DOUBLE');
		expect(located).toMatchObject({ ok: false });
		if (located.ok) return;
		expect(located.reason).toContain('more than once');
	});

	it('is scoped to the owner and the story', async () => {
		const scene = await makeScene(1, BODY);
		expect(await locateSplitInStory(db, strangerId, scene.id, 'MIDCUT')).toMatchObject({
			ok: false,
			reason: 'scene not found'
		});
	});
});
