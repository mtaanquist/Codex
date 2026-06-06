import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	chapters,
	characters,
	characterStoryMemberships,
	characterStoryNotes,
	entityCategories,
	loreEntries,
	places,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import { buildStoryZip, gatherStory } from '../../src/lib/server/export';
import { parseStoryZip } from '../../src/lib/import-markdown';
import { previewImport, runImport } from '../../src/lib/server/import-story';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let universe: { id: string; ownerId: string };

const noAssets = async () => [];

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query('truncate table scenes, chapters, stories, universes, users cascade');
	const [owner] = await db
		.insert(users)
		.values({ email: 'imp@example.com', displayName: 'I', passwordHash: 'x', role: 'user' })
		.returning();
	ownerId = owner.id;
	const [row] = await db.insert(universes).values({ ownerId, name: 'Mythos' }).returning();
	universe = { id: row.id, ownerId };
	await db
		.insert(entityCategories)
		.values({ universeId: row.id, ownerId, name: 'Lore', sortOrder: 1 });
});

afterAll(async () => {
	await pool.end();
});

// A story with chapters, an unfiled scene, and story notes, built through
// the real tables so the round trip exercises the real exporter.
async function seedStory() {
	const [story] = await db
		.insert(stories)
		.values({
			universeId: universe.id,
			ownerId,
			title: 'Halden',
			author: 'A. Vane',
			brief: 'A toll-road story.',
			descriptionMd: 'The long road.'
		})
		.returning();
	const [one] = await db
		.insert(chapters)
		.values({ storyId: story.id, title: 'The Caravan', position: 1 })
		.returning();
	const [two] = await db
		.insert(chapters)
		.values({ storyId: story.id, title: 'The Toll', position: 2 })
		.returning();
	await db.insert(scenes).values([
		{
			storyId: story.id,
			chapterId: one.id,
			positionInChapter: 1,
			globalPosition: 1,
			title: 'Departure',
			status: 'final',
			bodyMd: 'The gate opened.'
		},
		{
			storyId: story.id,
			chapterId: one.id,
			positionInChapter: 2,
			globalPosition: 2,
			title: 'Night',
			status: 'draft',
			bodyMd: 'Stars over the road.'
		},
		{
			storyId: story.id,
			chapterId: two.id,
			positionInChapter: 1,
			globalPosition: 3,
			title: 'Tollgate',
			status: 'revised',
			bodyMd: 'They paid in silver.'
		},
		{
			storyId: story.id,
			globalPosition: 4,
			title: 'Loose end',
			bodyMd: 'A stray thought.'
		}
	]);
	const [alice] = await db
		.insert(characters)
		.values({ universeId: universe.id, ownerId, name: 'Alice Vane' })
		.returning();
	await db
		.insert(characterStoryNotes)
		.values({ characterId: alice.id, storyId: story.id, notesMd: 'Limps in this book.' });
	return story;
}

async function exportPlan(story: Awaited<ReturnType<typeof seedStory>>) {
	const { bytes } = await buildStoryZip(story, await gatherStory(db, story), noAssets);
	return parseStoryZip(bytes);
}

describe('previewImport', () => {
	it('counts the work and resolves every note before anything is written', async () => {
		const plan = await exportPlan(await seedStory());
		// A second character named Alice makes the note ambiguous; Bram is new.
		await db.insert(characters).values({ universeId: universe.id, ownerId, name: 'alice vane' });
		plan.notes.push({ kind: 'character', name: 'Bram', notesMd: 'New here.' });

		const preview = await previewImport(db, universe, plan);
		expect(preview.storyTitle).toBe('Halden');
		expect(preview.titleTaken).toBe(true);
		expect(preview.chapterCount).toBe(2);
		expect(preview.sceneCount).toBe(4);
		expect(preview.words).toBeGreaterThan(0);
		expect(preview.notes).toEqual([
			{ kind: 'character', name: 'Alice Vane', outcome: 'ambiguous' },
			{ kind: 'character', name: 'Bram', outcome: 'create' }
		]);

		// Nothing was written.
		const storyRows = await db.select().from(stories);
		expect(storyRows).toHaveLength(1);
	});
});

describe('runImport', () => {
	it('round-trips a story export: chapters, scenes, statuses, and notes', async () => {
		const original = await seedStory();
		const plan = await exportPlan(original);
		const result = await runImport(db, universe, plan);

		expect(result.sceneCount).toBe(4);
		expect(result.notesAttached).toBe(1);
		expect(result.entitiesCreated).toBe(0);
		expect(result.notesSkipped).toBe(0);

		const [imported] = await db.select().from(stories).where(eq(stories.id, result.storyId));
		expect(imported.title).toBe('Halden');
		expect(imported.author).toBe('A. Vane');
		expect(imported.brief).toBe('A toll-road story.');
		expect(imported.descriptionMd).toBe('The long road.');
		expect(imported.slug).not.toBe(original.slug);

		const chapterRows = await db
			.select()
			.from(chapters)
			.where(eq(chapters.storyId, result.storyId))
			.orderBy(asc(chapters.position));
		expect(chapterRows.map((c) => c.title)).toEqual(['The Caravan', 'The Toll']);

		const sceneRows = await db
			.select()
			.from(scenes)
			.where(eq(scenes.storyId, result.storyId))
			.orderBy(asc(scenes.globalPosition));
		expect(sceneRows.map((s) => [s.title, s.status, s.bodyMd])).toEqual([
			['Departure', 'final', 'The gate opened.'],
			['Night', 'draft', 'Stars over the road.'],
			['Tollgate', 'revised', 'They paid in silver.'],
			['Loose end', 'draft', 'A stray thought.']
		]);
		expect(sceneRows[0].chapterId).toBe(chapterRows[0].id);
		expect(sceneRows[2].chapterId).toBe(chapterRows[1].id);
		expect(sceneRows[3].chapterId).toBeNull();
		expect(sceneRows[0].wordCount).toBeGreaterThan(0);

		// The note attached to the existing Alice, who joined the new story.
		const [alice] = await db.select().from(characters).where(eq(characters.name, 'Alice Vane'));
		const noteRows = await db
			.select()
			.from(characterStoryNotes)
			.where(eq(characterStoryNotes.storyId, result.storyId));
		expect(noteRows).toEqual([
			expect.objectContaining({ characterId: alice.id, notesMd: 'Limps in this book.' })
		]);
		const memberships = await db
			.select()
			.from(characterStoryMemberships)
			.where(eq(characterStoryMemberships.storyId, result.storyId));
		expect(memberships).toEqual([expect.objectContaining({ characterId: alice.id })]);
	});

	it('creates missing entities, skips ambiguous ones, and reports both', async () => {
		const plan = await exportPlan(await seedStory());
		await db.insert(places).values([
			{ universeId: universe.id, ownerId, name: 'The Toll Road' },
			{ universeId: universe.id, ownerId, name: 'The toll road' }
		]);
		plan.notes.push(
			{ kind: 'place', name: 'The Toll Road', notesMd: 'Crowded.' },
			{ kind: 'lore', name: 'The Silver Tax', notesMd: 'Steep this year.' }
		);

		const result = await runImport(db, universe, plan);
		expect(result.notesAttached).toBe(2);
		expect(result.entitiesCreated).toBe(1);
		expect(result.notesSkipped).toBe(1);
		expect(result.problems).toEqual([expect.stringContaining('The Toll Road')]);

		const [created] = await db
			.select()
			.from(loreEntries)
			.where(eq(loreEntries.title, 'The Silver Tax'));
		expect(created).toBeTruthy();
	});

	it('imports the same zip twice as two independent stories', async () => {
		const plan = await exportPlan(await seedStory());
		const first = await runImport(db, universe, plan);
		const second = await runImport(db, universe, plan);
		expect(second.storyId).not.toBe(first.storyId);
		expect(second.slug).not.toBe(first.slug);
		const titles = await db.select({ title: stories.title }).from(stories);
		expect(titles.filter((row) => row.title === 'Halden')).toHaveLength(3);
	});
});
