import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, asc, eq, isNull } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	chapters,
	characters,
	entityMentions,
	revisions,
	sceneMarkers,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import {
	deleteChapter,
	destroyScene,
	listTrashedScenes,
	moveChapter,
	renameChapter,
	restoreScene,
	trashScene
} from '../../src/lib/server/scene-lifecycle';
import { rebuildSceneMentions } from '../../src/lib/server/mentions';
import { applySceneOrder } from '../../src/lib/server/scene-order';
import { recordRevision } from '../../src/lib/server/revisions';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let strangerId: string;
let universeId: string;
let storyId: string;
let chapterA: string;
let chapterB: string;
let s1: string;
let s2: string;
let s3: string;

async function liveScenes() {
	return await db
		.select({
			id: scenes.id,
			chapterId: scenes.chapterId,
			globalPosition: scenes.globalPosition
		})
		.from(scenes)
		.where(and(eq(scenes.storyId, storyId), isNull(scenes.deletedAt)))
		.orderBy(asc(scenes.globalPosition));
}

async function mentionRows(sceneId: string) {
	return await db
		.select({ id: entityMentions.id })
		.from(entityMentions)
		.where(and(eq(entityMentions.sourceType, 'scene'), eq(entityMentions.sourceId, sceneId)));
}

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
	await pool.query(
		'truncate table entity_mentions, scene_markers, revisions, scenes, chapters, characters, stories, universes, users cascade'
	);

	const [owner] = await db
		.insert(users)
		.values({ email: 'life@example.com', displayName: 'L', passwordHash: 'x', role: 'user' })
		.returning();
	ownerId = owner.id;
	const [stranger] = await db
		.insert(users)
		.values({ email: 'life2@example.com', displayName: 'L2', passwordHash: 'x', role: 'user' })
		.returning();
	strangerId = stranger.id;
	const [universe] = await db.insert(universes).values({ ownerId, name: 'Lifeland' }).returning();
	universeId = universe.id;
	const [story] = await db
		.insert(stories)
		.values({ universeId, ownerId, title: 'Cycles' })
		.returning();
	storyId = story.id;
	const [a] = await db.insert(chapters).values({ storyId, position: 1, title: 'One' }).returning();
	const [b] = await db.insert(chapters).values({ storyId, position: 2 }).returning();
	chapterA = a.id;
	chapterB = b.id;
	const rows = await db
		.insert(scenes)
		.values([
			{
				storyId,
				chapterId: chapterA,
				positionInChapter: 1,
				globalPosition: 1,
				title: 'First',
				bodyMd: 'Aldric walks in.'
			},
			{
				storyId,
				chapterId: chapterA,
				positionInChapter: 2,
				globalPosition: 2,
				title: 'Second'
			},
			{ storyId, chapterId: null, globalPosition: 3, title: 'Loose' }
		])
		.returning();
	[s1, s2, s3] = rows.map((row) => row.id);
	await db.insert(characters).values({ universeId, ownerId, name: 'Aldric' });
});

afterAll(async () => {
	await pool.end();
});

describe('trashScene', () => {
	it('hides the scene and drops its mention rows', async () => {
		await rebuildSceneMentions(db, s1);
		expect((await mentionRows(s1)).length).toBeGreaterThan(0);

		expect(await trashScene(db, ownerId, s1)).toBe(true);
		expect((await liveScenes()).map((row) => row.id)).toEqual([s2, s3]);
		expect(await mentionRows(s1)).toHaveLength(0);
		expect((await listTrashedScenes(db, storyId)).map((row) => row.id)).toEqual([s1]);
	});

	it('guards ownership and double deletion', async () => {
		expect(await trashScene(db, strangerId, s2)).toBe(false);
		expect(await trashScene(db, ownerId, s1)).toBe(false);
	});

	it('keeps the scene order valid without the trashed scene', async () => {
		const result = await applySceneOrder(db, storyId, {
			chapters: [
				{ id: chapterA, sceneIds: [s2] },
				{ id: chapterB, sceneIds: [] }
			],
			orphanSceneIds: [s3]
		});
		expect(result.ok).toBe(true);
	});

	it('a rebuild queued before the deletion cannot bring mentions back', async () => {
		const result = await rebuildSceneMentions(db, s1);
		expect(result).toEqual({ ok: true, count: 0 });
		expect(await mentionRows(s1)).toHaveLength(0);
	});
});

describe('restoreScene', () => {
	it('returns the scene to its chapter at the end of the story order', async () => {
		expect(await restoreScene(db, ownerId, s1)).toBe(true);
		const live = await liveScenes();
		expect(live.map((row) => row.id)).toEqual([s2, s3, s1]);
		expect(live[2].chapterId).toBe(chapterA);
		expect(await listTrashedScenes(db, storyId)).toHaveLength(0);
	});

	it('only works from the trash', async () => {
		expect(await restoreScene(db, ownerId, s1)).toBe(false);
	});

	it('lands unfiled when the chapter is gone', async () => {
		await trashScene(db, ownerId, s1);
		await deleteChapter(db, ownerId, chapterA);
		expect(await restoreScene(db, ownerId, s1)).toBe(true);
		const live = await liveScenes();
		expect(live.find((row) => row.id === s1)?.chapterId).toBe(null);
	});
});

describe('destroyScene', () => {
	it('refuses a live scene and a stranger', async () => {
		expect(await destroyScene(db, ownerId, s1)).toBe(false);
		await trashScene(db, ownerId, s1);
		expect(await destroyScene(db, strangerId, s1)).toBe(false);
	});

	it('removes the scene and everything it owns', async () => {
		await db.insert(sceneMarkers).values({ sceneId: s1, ownerId, kind: 'todo' });
		await recordRevision(db, 'scene', s1, 'Aldric walks in.');

		expect(await destroyScene(db, ownerId, s1)).toBe(true);
		expect(await db.select().from(scenes).where(eq(scenes.id, s1))).toHaveLength(0);
		expect(await db.select().from(sceneMarkers).where(eq(sceneMarkers.sceneId, s1))).toHaveLength(
			0
		);
		expect(await db.select().from(revisions).where(eq(revisions.entityId, s1))).toHaveLength(0);
	});
});

describe('chapters', () => {
	it('renames, clears back to the default, and guards ownership', async () => {
		expect(await renameChapter(db, ownerId, chapterB, '  Act Two  ')).toBe(true);
		let [row] = await db.select().from(chapters).where(eq(chapters.id, chapterB));
		expect(row.title).toBe('Act Two');
		expect(await renameChapter(db, strangerId, chapterB, 'Mine')).toBe(false);
		expect(await renameChapter(db, ownerId, chapterB, '')).toBe(true);
		[row] = await db.select().from(chapters).where(eq(chapters.id, chapterB));
		expect(row.title).toBe(null);
	});

	it('moves chapters and treats the ends as no-ops', async () => {
		const [c] = await db.insert(chapters).values({ storyId, position: 3, title: 'C' }).returning();
		expect(await moveChapter(db, ownerId, c.id, 'up')).toBe(true);
		let list = await db
			.select({ id: chapters.id })
			.from(chapters)
			.where(eq(chapters.storyId, storyId))
			.orderBy(asc(chapters.position));
		expect(list.map((row) => row.id)).toEqual([c.id, chapterB]);
		expect(await moveChapter(db, ownerId, c.id, 'up')).toBe(true);
		list = await db
			.select({ id: chapters.id })
			.from(chapters)
			.where(eq(chapters.storyId, storyId))
			.orderBy(asc(chapters.position));
		expect(list.map((row) => row.id)).toEqual([c.id, chapterB]);
		await db.delete(chapters).where(eq(chapters.id, c.id));
	});

	it('deleting a chapter unfiles its scenes and renumbers the rest', async () => {
		const [c] = await db.insert(chapters).values({ storyId, position: 3, title: 'C' }).returning();
		await db
			.update(scenes)
			.set({ chapterId: chapterB, positionInChapter: 1 })
			.where(eq(scenes.id, s2));
		expect(await deleteChapter(db, ownerId, chapterB)).toBe(true);
		const [moved] = await db
			.select({ chapterId: scenes.chapterId, positionInChapter: scenes.positionInChapter })
			.from(scenes)
			.where(eq(scenes.id, s2));
		expect(moved.chapterId).toBe(null);
		expect(moved.positionInChapter).toBe(null);
		const rest = await db
			.select({ id: chapters.id, position: chapters.position })
			.from(chapters)
			.where(eq(chapters.storyId, storyId))
			.orderBy(asc(chapters.position));
		expect(rest).toEqual([{ id: c.id, position: 1 }]);
		expect(await deleteChapter(db, strangerId, c.id)).toBe(false);
	});
});
