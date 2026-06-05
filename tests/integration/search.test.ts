import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	characters,
	entityCategories,
	loreEntries,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import { searchAll } from '../../src/lib/server/search';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let strangerId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
	await pool.query('truncate table users cascade');

	const [owner] = await db
		.insert(users)
		.values({ email: 'find@example.com', displayName: 'F', passwordHash: 'x', role: 'user' })
		.returning();
	ownerId = owner.id;
	const [stranger] = await db
		.insert(users)
		.values({ email: 'find2@example.com', displayName: 'F2', passwordHash: 'x', role: 'user' })
		.returning();
	strangerId = stranger.id;

	const [universe] = await db
		.insert(universes)
		.values({ ownerId, name: 'The Ashlands', slug: 'the-ashlands' })
		.returning();
	const [story] = await db
		.insert(stories)
		.values({ universeId: universe.id, ownerId, title: 'Book of Ash', slug: 'book-of-ash' })
		.returning();
	await db
		.insert(scenes)
		.values({ storyId: story.id, globalPosition: 1, title: 'The toll-gate at dusk' });
	await db.insert(characters).values({
		universeId: universe.id,
		ownerId,
		name: 'Marra',
		aliases: ['the Ash Queen']
	});
	const [category] = await db
		.insert(entityCategories)
		.values({ universeId: universe.id, ownerId, name: 'Lore', sortOrder: 0 })
		.returning();
	await db.insert(loreEntries).values({
		universeId: universe.id,
		ownerId,
		categoryId: category.id,
		title: 'The Long Winter',
		keywords: ['ashfall']
	});
});

afterAll(async () => {
	await pool.end();
});

describe('searchAll', () => {
	it('finds everything by substring, case-insensitively', async () => {
		const results = await searchAll(db, ownerId, 'ash');
		const labels = results.map((result) => `${result.type}:${result.label}`);
		expect(labels).toContain('universe:The Ashlands');
		expect(labels).toContain('story:Book of Ash');
		expect(labels).toContain('character:Marra'); // via the alias
		expect(labels).toContain('lore:The Long Winter'); // via the keyword
	});

	it('matches scene titles and links into the story', async () => {
		const results = await searchAll(db, ownerId, 'toll');
		expect(results).toHaveLength(1);
		expect(results[0].type).toBe('scene');
		// Search links carry the story slug; the scene stays a query id.
		expect(results[0].href).toMatch(/^\/stories\/book-of-ash\?scene=[0-9a-f-]{36}$/);
		expect(results[0].sublabel).toBe('Book of Ash');
	});

	it('is owner-scoped and treats wildcards as literals', async () => {
		expect(await searchAll(db, strangerId, 'ash')).toEqual([]);
		expect(await searchAll(db, ownerId, '%')).toEqual([]);
		expect(await searchAll(db, ownerId, '  ')).toEqual([]);
	});
});
