import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, eq } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	entityCategories,
	loreEntries,
	loreStoryNotes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import { saveLoreEntry } from '../../src/lib/server/lore';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let storyId: string;
let entryId: string;
let loreCategoryId: string;
let factionCategoryId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
	await pool.query(
		'truncate table lore_story_notes, lore_entries, entity_categories, stories, universes, users cascade'
	);

	const [owner] = await db
		.insert(users)
		.values({ email: 'lore@example.com', displayName: 'Lore', passwordHash: 'x', role: 'user' })
		.returning();
	ownerId = owner.id;
	const [universe] = await db.insert(universes).values({ ownerId, name: 'U' }).returning();
	const [story] = await db
		.insert(stories)
		.values({ universeId: universe.id, ownerId, title: 'S' })
		.returning();
	storyId = story.id;
	const [loreCat] = await db
		.insert(entityCategories)
		.values({ universeId: universe.id, ownerId, name: 'Lore', sortOrder: 0 })
		.returning();
	loreCategoryId = loreCat.id;
	const [factionCat] = await db
		.insert(entityCategories)
		.values({
			universeId: universe.id,
			ownerId,
			name: 'Factions',
			color: 'var(--cat-rose)',
			sortOrder: 1
		})
		.returning();
	factionCategoryId = factionCat.id;
	const [entry] = await db
		.insert(loreEntries)
		.values({ universeId: universe.id, ownerId, categoryId: loreCategoryId, title: 'Toll-pass' })
		.returning();
	entryId = entry.id;
});

afterAll(async () => {
	await pool.end();
});

describe('saveLoreEntry', () => {
	it('updates fields, keywords round-trip, and reports mention impact', async () => {
		const changed = await saveLoreEntry(db, entryId, ownerId, {
			name: 'Toll-pass',
			keywords: ['toll', ' pass-stamp ', ''],
			summaryMd: 'Paper that opens the gate.',
			bodyMd: 'Issued in Halden, honoured nowhere else.'
		});
		expect(changed).toMatchObject({ ok: true, mentionsAffected: true });

		const unchanged = await saveLoreEntry(db, entryId, ownerId, {
			name: 'Toll-pass',
			keywords: ['toll', 'pass-stamp'],
			summaryMd: 'Body-only edits do not reindex.',
			bodyMd: 'New body.'
		});
		expect(unchanged).toMatchObject({ ok: true, mentionsAffected: false });

		const [row] = await db.select().from(loreEntries).where(eq(loreEntries.id, entryId));
		expect(row.keywords).toEqual(['toll', 'pass-stamp']);
	});

	it('moves an entry between categories of the same universe', async () => {
		const result = await saveLoreEntry(db, entryId, ownerId, {
			name: 'Toll-pass',
			keywords: ['toll', 'pass-stamp'],
			summaryMd: null,
			bodyMd: '',
			categoryId: factionCategoryId
		});
		expect(result.ok).toBe(true);
		const [row] = await db.select().from(loreEntries).where(eq(loreEntries.id, entryId));
		expect(row.categoryId).toBe(factionCategoryId);
	});

	it('rejects a category from another universe', async () => {
		const [other] = await db.insert(universes).values({ ownerId, name: 'Other' }).returning();
		const [foreignCat] = await db
			.insert(entityCategories)
			.values({ universeId: other.id, ownerId, name: 'Foreign', sortOrder: 0 })
			.returning();
		const result = await saveLoreEntry(db, entryId, ownerId, {
			name: 'Toll-pass',
			keywords: [],
			summaryMd: null,
			bodyMd: '',
			categoryId: foreignCat.id
		});
		expect(result).toMatchObject({ ok: false });
	});

	it('upserts the per-story notes', async () => {
		for (const notes of ['First.', 'Second.']) {
			const result = await saveLoreEntry(db, entryId, ownerId, {
				name: 'Toll-pass',
				keywords: [],
				summaryMd: null,
				bodyMd: '',
				storyId,
				storyNotesMd: notes
			});
			expect(result.ok).toBe(true);
		}
		const rows = await db
			.select()
			.from(loreStoryNotes)
			.where(and(eq(loreStoryNotes.loreEntryId, entryId), eq(loreStoryNotes.storyId, storyId)));
		expect(rows).toHaveLength(1);
		expect(rows[0].notesMd).toBe('Second.');
	});
});
