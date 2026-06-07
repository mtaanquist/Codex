import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { entityCategories, loreEntries, universes, users } from '../../src/lib/server/db/schema';
import { listCategories, saveCategories, universeContents } from '../../src/lib/server/categories';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let universeId: string;
let loreCat: string;
let emptyCat: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
	await pool.query('truncate table users cascade');

	const [owner] = await db
		.insert(users)
		.values({ email: 'cat@example.com', displayName: 'C', passwordHash: 'x', role: 'user' })
		.returning();
	ownerId = owner.id;
	const [universe] = await db
		.insert(universes)
		.values({ ownerId, name: 'Sorted', slug: 'sorted' })
		.returning();
	universeId = universe.id;
	const [a] = await db
		.insert(entityCategories)
		.values({ universeId, ownerId, name: 'Lore', sortOrder: 0 })
		.returning();
	loreCat = a.id;
	const [b] = await db
		.insert(entityCategories)
		.values({ universeId, ownerId, name: 'Factions', color: '#aa3355', sortOrder: 1 })
		.returning();
	emptyCat = b.id;
	await db
		.insert(loreEntries)
		.values({ universeId, ownerId, categoryId: loreCat, title: 'The Treaty' });
});

afterAll(async () => {
	await pool.end();
});

describe('saveCategories', () => {
	it('renames, recolours, reorders, adds, and deletes empty categories in one save', async () => {
		const result = await saveCategories(db, { universeId, ownerId }, [
			{ id: emptyCat, name: 'Guilds', color: 'var(--cat-violet)' },
			{ id: loreCat, name: 'Old Lore', color: null },
			{ id: null, name: 'Rituals', color: 'var(--cat-teal)' }
		]);
		expect(result).toEqual({ ok: true });
		const after = await listCategories(db, universeId);
		expect(after.map((row) => [row.name, row.color, row.entries])).toEqual([
			['Guilds', 'var(--cat-violet)', 0],
			['Old Lore', null, 1],
			['Rituals', 'var(--cat-teal)', 0]
		]);
	});

	it('refuses to delete an occupied category, an empty list, and junk', async () => {
		const drop = await saveCategories(db, { universeId, ownerId }, [
			{ id: emptyCat, name: 'Guilds', color: null }
		]);
		expect(drop).toMatchObject({ ok: false });
		expect((drop as { reason: string }).reason).toContain('Old Lore');

		expect(await saveCategories(db, { universeId, ownerId }, [])).toMatchObject({ ok: false });
		expect(
			await saveCategories(db, { universeId, ownerId }, [{ id: null, name: '  ', color: null }])
		).toMatchObject({ ok: false });
		expect(
			await saveCategories(db, { universeId, ownerId }, [
				{ id: null, name: 'Bad colour', color: 'red' }
			])
		).toMatchObject({ ok: false });
	});

	it('accepts a palette token but rejects a hex colour and an over-long name', async () => {
		const list = await listCategories(db, universeId);
		const guild = list.find((row) => row.name === 'Guilds')!;
		// A palette token the plan sidebar produces saves cleanly.
		expect(
			await saveCategories(
				db,
				{ universeId, ownerId },
				list.map((row) =>
					row.id === guild.id
						? { id: row.id, name: row.name, color: 'var(--cat-amber)' }
						: { id: row.id, name: row.name, color: row.color }
				)
			)
		).toEqual({ ok: true });
		// A raw hex value (the old free picker) is no longer a valid colour.
		expect(
			await saveCategories(
				db,
				{ universeId, ownerId },
				list.map((row) =>
					row.id === guild.id
						? { id: row.id, name: row.name, color: '#7d5fe0' }
						: { id: row.id, name: row.name, color: row.color }
				)
			)
		).toMatchObject({ ok: false });
		// And the name length is bounded.
		expect(
			await saveCategories(
				db,
				{ universeId, ownerId },
				list.map((row) =>
					row.id === guild.id
						? { id: row.id, name: 'x'.repeat(61), color: row.color }
						: { id: row.id, name: row.name, color: row.color }
				)
			)
		).toMatchObject({ ok: false });
	});

	it('deleting an emptied category works once nothing uses it', async () => {
		const list = await listCategories(db, universeId);
		const keep = list.filter((row) => row.name !== 'Rituals');
		const result = await saveCategories(
			db,
			{ universeId, ownerId },
			keep.map((row) => ({ id: row.id, name: row.name, color: row.color }))
		);
		expect(result).toEqual({ ok: true });
		expect((await listCategories(db, universeId)).map((row) => row.name)).toEqual([
			'Guilds',
			'Old Lore'
		]);
	});
});

describe('universeContents', () => {
	it('counts what the universe holds', async () => {
		const contents = await universeContents(db, universeId);
		expect(contents).toEqual({ stories: 0, characters: 0, places: 0, lore: 1, words: 0 });
	});
});
