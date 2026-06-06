import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
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
import { countProseMatches, replaceProse } from '../../src/lib/server/prose-replace';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let universeId: string;
let otherUniverseId: string;
let hit: string;
let cold: string;
let trashed: string;
let elsewhere: string;
let markerId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
	await pool.query(
		'truncate table scene_markers, revisions, scenes, chapters, stories, universes, users cascade'
	);

	const [owner] = await db
		.insert(users)
		.values({ email: 'sweep@example.com', displayName: 'S', passwordHash: 'x', role: 'user' })
		.returning();
	ownerId = owner.id;
	const [universe] = await db.insert(universes).values({ ownerId, name: 'Sweepverse' }).returning();
	universeId = universe.id;
	const [other] = await db.insert(universes).values({ ownerId, name: 'Elsewhere' }).returning();
	otherUniverseId = other.id;
	const [story] = await db.insert(stories).values({ universeId, ownerId, title: 'S' }).returning();
	const [otherStory] = await db
		.insert(stories)
		.values({ universeId: otherUniverseId, ownerId, title: 'O' })
		.returning();

	// "Alice" twice as a word, once embedded; "Alicester" must not count.
	const [hitRow] = await db
		.insert(scenes)
		.values({
			storyId: story.id,
			globalPosition: 1,
			bodyMd: "Alice rode to Alicester. Alice's horse tired.",
			wordCount: 7
		})
		.returning();
	hit = hitRow.id;
	const [coldRow] = await db
		.insert(scenes)
		.values({ storyId: story.id, globalPosition: 2, bodyMd: 'Nobody here.', wordCount: 2 })
		.returning();
	cold = coldRow.id;
	const [trashedRow] = await db
		.insert(scenes)
		.values({
			storyId: story.id,
			globalPosition: 3,
			bodyMd: 'Alice in the bin.',
			wordCount: 4,
			deletedAt: new Date()
		})
		.returning();
	trashed = trashedRow.id;
	const [elsewhereRow] = await db
		.insert(scenes)
		.values({
			storyId: otherStory.id,
			globalPosition: 1,
			bodyMd: 'Alice in another universe.',
			wordCount: 4
		})
		.returning();
	elsewhere = elsewhereRow.id;

	// A marker anchored after both occurrences: on "tired" (35..40).
	const body = "Alice rode to Alicester. Alice's horse tired.";
	const [marker] = await db
		.insert(sceneMarkers)
		.values({
			sceneId: hit,
			ownerId,
			kind: 'todo',
			anchorStart: body.indexOf('tired'),
			anchorEnd: body.indexOf('tired') + 5
		})
		.returning();
	markerId = marker.id;
});

afterAll(async () => {
	await pool.end();
});

describe('countProseMatches', () => {
	it('counts whole-word occurrences in live scenes of the universe only', async () => {
		expect(await countProseMatches(db, universeId, 'Alice')).toEqual({
			scenes: 1,
			occurrences: 2
		});
		expect(await countProseMatches(db, universeId, 'Alicester')).toEqual({
			scenes: 1,
			occurrences: 1
		});
		expect(await countProseMatches(db, universeId, 'Nobody Special')).toEqual({
			scenes: 0,
			occurrences: 0
		});
	});
});

describe('replaceProse', () => {
	it('replaces, recounts words, moves markers, records a checkpoint, and stays in scope', async () => {
		const result = await replaceProse(db, universeId, 'Alice', 'Maundy Vex');
		expect(result).toEqual({ scenes: 1, occurrences: 2 });

		const [after] = await db.select().from(scenes).where(eq(scenes.id, hit));
		expect(after.bodyMd).toBe("Maundy Vex rode to Alicester. Maundy Vex's horse tired.");
		expect(after.wordCount).toBe(9);

		// The marker still wraps "tired".
		const [marker] = await db.select().from(sceneMarkers).where(eq(sceneMarkers.id, markerId));
		expect(after.bodyMd.slice(marker.anchorStart!, marker.anchorEnd!)).toBe('tired');

		// One checkpoint revision carrying the sweep's label.
		const revisionRows = await db.select().from(revisions).where(eq(revisions.entityId, hit));
		expect(revisionRows).toHaveLength(1);
		expect(revisionRows[0]).toMatchObject({
			reason: 'checkpoint',
			label: 'Renamed "Alice" to "Maundy Vex"'
		});

		// Untouched: the cold scene, the trashed scene, the other universe.
		const [coldAfter] = await db.select().from(scenes).where(eq(scenes.id, cold));
		expect(coldAfter.bodyMd).toBe('Nobody here.');
		const [trashedAfter] = await db.select().from(scenes).where(eq(scenes.id, trashed));
		expect(trashedAfter.bodyMd).toBe('Alice in the bin.');
		const [elsewhereAfter] = await db.select().from(scenes).where(eq(scenes.id, elsewhere));
		expect(elsewhereAfter.bodyMd).toBe('Alice in another universe.');
	});
});
