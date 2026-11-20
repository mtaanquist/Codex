import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { asc, eq } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	chapters,
	revisions,
	sceneMarkers,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import { findInStory, replaceInStory } from '../../src/lib/server/story-replace';
import { saveSceneBody } from '../../src/lib/server/scene-save';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let storyId: string;
let chapterOne: string;
let chapterTwo: string;
// Reading order: first (ch 1), second (ch 1), third (ch 2), unfiled.
let first: string;
let second: string;
let third: string;
let unfiled: string;
let trashed: string;
let otherStoryScene: string;

const WORD = { matchCase: true, wholeWord: true };

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query(
		'truncate table scene_markers, revisions, scenes, chapters, stories, universes, users cascade'
	);
	const [owner] = await db
		.insert(users)
		.values({ email: 'replace@example.com', displayName: 'R', passwordHash: 'x', role: 'user' })
		.returning();
	ownerId = owner.id;
	const [universe] = await db.insert(universes).values({ ownerId, name: 'U' }).returning();
	const [story] = await db
		.insert(stories)
		.values({ universeId: universe.id, ownerId, title: 'S' })
		.returning();
	storyId = story.id;
	const [other] = await db
		.insert(stories)
		.values({ universeId: universe.id, ownerId, title: 'O' })
		.returning();
	const [c1] = await db.insert(chapters).values({ storyId, position: 1 }).returning();
	const [c2] = await db.insert(chapters).values({ storyId, position: 2 }).returning();
	chapterOne = c1.id;
	chapterTwo = c2.id;
	const scene = async (values: Partial<typeof scenes.$inferInsert> & { bodyMd: string }) =>
		(
			await db
				.insert(scenes)
				.values({ storyId, globalPosition: 0, wordCount: 1, ...values })
				.returning()
		)[0].id;
	// Inserted out of order: results must follow globalPosition.
	third = await scene({
		chapterId: chapterTwo,
		globalPosition: 3,
		bodyMd: 'The city burned.'
	});
	first = await scene({
		chapterId: chapterOne,
		globalPosition: 1,
		title: 'Arrival',
		bodyMd: 'The city gates. A city of glass. Velocity. CITY.'
	});
	second = await scene({ chapterId: chapterOne, globalPosition: 2, bodyMd: 'No match here.' });
	unfiled = await scene({ globalPosition: 4, bodyMd: 'Back to the city.' });
	trashed = await scene({ globalPosition: 5, bodyMd: 'A city in the bin.', deletedAt: new Date() });
	otherStoryScene = await scene({ storyId: other.id, globalPosition: 1, bodyMd: 'Another city.' });
});

afterAll(async () => {
	await pool.end();
});

async function body(sceneId: string) {
	const [row] = await db
		.select({ bodyMd: scenes.bodyMd })
		.from(scenes)
		.where(eq(scenes.id, sceneId));
	return row.bodyMd;
}

describe('findInStory', () => {
	it('lists matches per scene in reading order, story-wide, leaving out the trash', async () => {
		const result = await findInStory(db, { storyId, chapterId: null }, 'city', WORD);
		expect(result.scenes.map((s) => s.sceneId)).toEqual([first, third, unfiled]);
		expect(result.scenes.map((s) => s.sceneId)).not.toContain(second);
		expect(result.matchCount).toBe(4);
		expect(result.truncated).toBe(false);
		const [arrival] = result.scenes;
		expect(arrival.title).toBe('Arrival');
		expect(arrival.chapterId).toBe(chapterOne);
		expect(arrival.matches[0]).toMatchObject({ start: 4, end: 8, text: 'city' });
		expect(arrival.matches[0].before).toBe('The ');
		expect(result.scenes.some((s) => s.sceneId === trashed || s.sceneId === otherStoryScene)).toBe(
			false
		);
	});

	it('narrows to one chapter', async () => {
		const result = await findInStory(db, { storyId, chapterId: chapterTwo }, 'city', WORD);
		expect(result.scenes.map((s) => s.sceneId)).toEqual([third]);
	});

	it('honours match case and whole word', async () => {
		const loose = await findInStory(db, { storyId, chapterId: chapterOne }, 'city', {
			matchCase: false,
			wholeWord: false
		});
		// city, city, (Velo)city, CITY
		expect(loose.matchCount).toBe(4);
	});
});

describe('replaceInStory', () => {
	it('replaces only the chosen matches, with a History entry per changed scene', async () => {
		const found = await findInStory(db, { storyId, chapterId: null }, 'city', WORD);
		const [arrival, burned] = found.scenes;
		const result = await replaceInStory(
			db,
			{ storyId, chapterId: null },
			{
				find: 'city',
				replace: 'village',
				options: WORD,
				scenes: [
					// Only the second match in the first scene.
					{
						sceneId: arrival.sceneId,
						baseHash: arrival.baseHash,
						starts: [arrival.matches[1].start]
					},
					{
						sceneId: burned.sceneId,
						baseHash: burned.baseHash,
						starts: burned.matches.map((m) => m.start)
					}
				]
			}
		);
		expect(result).toEqual({ scenesChanged: 2, replaced: 2, skipped: [] });
		expect(await body(first)).toBe('The city gates. A village of glass. Velocity. CITY.');
		expect(await body(third)).toBe('The village burned.');
		// Not chosen: left alone.
		expect(await body(unfiled)).toBe('Back to the city.');
		expect(await body(otherStoryScene)).toBe('Another city.');

		// The old text, then the labelled checkpoint, for each changed scene.
		const history = await db
			.select({ bodyMd: revisions.bodyMd, reason: revisions.reason, label: revisions.label })
			.from(revisions)
			.where(eq(revisions.entityId, third))
			.orderBy(asc(revisions.createdAt));
		expect(history).toEqual([
			{ bodyMd: 'The city burned.', reason: 'autosave', label: null },
			{
				bodyMd: 'The village burned.',
				reason: 'checkpoint',
				label: 'Replaced "city" with "village"'
			}
		]);
		expect(await db.select().from(revisions).where(eq(revisions.entityId, unfiled))).toHaveLength(
			0
		);
	});

	it('skips a scene whose text changed since the search, and reports it', async () => {
		const found = await findInStory(db, { storyId, chapterId: null }, 'city', WORD);
		const burned = found.scenes.find((s) => s.sceneId === third)!;
		const saved = await saveSceneBody(db, third, {
			title: null,
			bodyMd: 'The city burned twice.',
			anchors: null,
			baseHashes: null,
			overwrite: false
		});
		expect(saved.ok).toBe(true);
		const result = await replaceInStory(
			db,
			{ storyId, chapterId: null },
			{
				find: 'city',
				replace: 'village',
				options: WORD,
				scenes: [{ sceneId: third, baseHash: burned.baseHash, starts: [4] }]
			}
		);
		expect(result).toEqual({
			scenesChanged: 0,
			replaced: 0,
			skipped: [{ sceneId: third, title: null, reason: 'changed' }]
		});
		expect(await body(third)).toBe('The city burned twice.');
	});

	it('leaves alone scenes outside the scope, in the trash, or in another story', async () => {
		const hashOf = async (sceneId: string) => {
			const { textHash } = await import('../../src/lib/text-hash');
			return textHash(await body(sceneId));
		};
		const result = await replaceInStory(
			db,
			{ storyId, chapterId: chapterOne },
			{
				find: 'city',
				replace: 'village',
				options: WORD,
				scenes: [
					{ sceneId: third, baseHash: await hashOf(third), starts: [4] },
					{ sceneId: trashed, baseHash: await hashOf(trashed), starts: [2] },
					{ sceneId: otherStoryScene, baseHash: await hashOf(otherStoryScene), starts: [8] }
				]
			}
		);
		expect(result.scenesChanged).toBe(0);
		expect(result.skipped.map((s) => s.sceneId)).toEqual([third, trashed, otherStoryScene]);
		expect(await body(third)).toBe('The city burned.');
		expect(await body(trashed)).toBe('A city in the bin.');
		expect(await body(otherStoryScene)).toBe('Another city.');
	});

	it('ignores offsets that are not matches', async () => {
		const found = await findInStory(db, { storyId, chapterId: null }, 'city', WORD);
		const burned = found.scenes.find((s) => s.sceneId === third)!;
		const result = await replaceInStory(
			db,
			{ storyId, chapterId: null },
			{
				find: 'city',
				replace: 'village',
				options: WORD,
				scenes: [{ sceneId: third, baseHash: burned.baseHash, starts: [0, 5] }]
			}
		);
		expect(result).toEqual({ scenesChanged: 0, replaced: 0, skipped: [] });
		expect(await body(third)).toBe('The city burned.');
	});

	it('keeps markers on their words and works on Windows line endings', async () => {
		const stored = 'A city.\r\nThe city slept.';
		const shown = stored.replace(/\r\n/g, '\n');
		await db.update(scenes).set({ bodyMd: stored }).where(eq(scenes.id, third));
		const slept = shown.indexOf('slept');
		const [marker] = await db
			.insert(sceneMarkers)
			.values({ sceneId: third, ownerId, anchorStart: slept, anchorEnd: slept + 5 })
			.returning();
		const found = await findInStory(db, { storyId, chapterId: chapterTwo }, 'city', WORD);
		const [scene] = found.scenes;
		expect(scene.matches.map((m) => m.start)).toEqual([2, shown.lastIndexOf('city')]);
		const result = await replaceInStory(
			db,
			{ storyId, chapterId: chapterTwo },
			{
				find: 'city',
				replace: 'town',
				options: WORD,
				scenes: [
					{ sceneId: third, baseHash: scene.baseHash, starts: scene.matches.map((m) => m.start) }
				]
			}
		);
		expect(result.replaced).toBe(2);
		const after = await body(third);
		expect(after).toBe('A town.\nThe town slept.');
		const [moved] = await db.select().from(sceneMarkers).where(eq(sceneMarkers.id, marker.id));
		expect(after.slice(moved.anchorStart!, moved.anchorEnd!)).toBe('slept');
	});

	it('detaches a marker whose passage is replaced with nothing', async () => {
		const [marker] = await db
			.insert(sceneMarkers)
			.values({ sceneId: third, ownerId, anchorStart: 4, anchorEnd: 8 })
			.returning();
		const found = await findInStory(db, { storyId, chapterId: chapterTwo }, 'city ', {
			matchCase: true,
			wholeWord: false
		});
		const [scene] = found.scenes;
		const result = await replaceInStory(
			db,
			{ storyId, chapterId: chapterTwo },
			{
				find: 'city ',
				replace: '',
				options: { matchCase: true, wholeWord: false },
				scenes: [{ sceneId: third, baseHash: scene.baseHash, starts: [4] }]
			}
		);
		expect(result.replaced).toBe(1);
		expect(await body(third)).toBe('The burned.');
		const [after] = await db.select().from(sceneMarkers).where(eq(sceneMarkers.id, marker.id));
		expect(after.anchorStart).toBeNull();
		expect(after.anchorEnd).toBeNull();
	});

	it('writes nothing when the replacement leaves the text as it was', async () => {
		const loose = { matchCase: false, wholeWord: true };
		const found = await findInStory(db, { storyId, chapterId: chapterTwo }, 'CITY', loose);
		const [scene] = found.scenes;
		const result = await replaceInStory(
			db,
			{ storyId, chapterId: chapterTwo },
			{
				find: 'CITY',
				replace: 'city',
				options: loose,
				scenes: [{ sceneId: third, baseHash: scene.baseHash, starts: [4] }]
			}
		);
		expect(result).toEqual({ scenesChanged: 0, replaced: 0, skipped: [] });
		expect(await db.select().from(revisions).where(eq(revisions.entityId, third))).toHaveLength(0);
	});

	it('leaves a scene alone when the replace would make it too long to save', async () => {
		const long = 'city '.repeat(399_000);
		await db.update(scenes).set({ bodyMd: long }).where(eq(scenes.id, third));
		const found = await findInStory(db, { storyId, chapterId: chapterTwo }, 'city', WORD);
		const [scene] = found.scenes;
		const result = await replaceInStory(
			db,
			{ storyId, chapterId: chapterTwo },
			{
				find: 'city',
				replace: 'metropolis',
				options: WORD,
				scenes: [
					{ sceneId: third, baseHash: scene.baseHash, starts: scene.matches.map((m) => m.start) }
				]
			}
		);
		expect(result.skipped).toEqual([{ sceneId: third, title: null, reason: 'too_long' }]);
		expect(await body(third)).toBe(long);
	});
});
