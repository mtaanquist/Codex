import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	characters,
	entityCategories,
	loreEntries,
	places,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import { saveEntity, type EntitySaveKind } from '../../src/lib/server/entity-save';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

// The three kinds share one save flow; these assert the behaviours that must
// stay identical across them (the per-kind details live in the kind tests).

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let categoryId: string;
const ids: Record<EntitySaveKind, string> = { character: '', place: '', lore: '' };

const BASE = { summaryMd: null, bodyMd: 'A body.' };

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
	await pool.query(
		'truncate table characters, places, lore_entries, entity_categories, stories, universes, users cascade'
	);
	const [owner] = await db
		.insert(users)
		.values({ email: 'kinds@example.com', displayName: 'K', passwordHash: 'x', role: 'user' })
		.returning();
	ownerId = owner.id;
	const [universe] = await db.insert(universes).values({ ownerId, name: 'U' }).returning();
	await db.insert(stories).values({ universeId: universe.id, ownerId, title: 'S' });
	const [category] = await db
		.insert(entityCategories)
		.values({ universeId: universe.id, ownerId, name: 'Cat', sortOrder: 0 })
		.returning();
	categoryId = category.id;
	const [character] = await db
		.insert(characters)
		.values({ universeId: universe.id, ownerId, name: 'Alice' })
		.returning();
	ids.character = character.id;
	const [place] = await db
		.insert(places)
		.values({ universeId: universe.id, ownerId, name: 'Halden' })
		.returning();
	ids.place = place.id;
	const [lore] = await db
		.insert(loreEntries)
		.values({ universeId: universe.id, ownerId, title: 'Toll', categoryId: category.id })
		.returning();
	ids.lore = lore.id;
});

afterAll(async () => {
	await pool.end();
});

const KINDS: EntitySaveKind[] = ['character', 'place', 'lore'];
const NAMES: Record<EntitySaveKind, string> = {
	character: 'Alice',
	place: 'Halden',
	lore: 'Toll'
};

describe('saveEntity across kinds', () => {
	it('reports mentionsAffected only when the name or tags change', async () => {
		for (const kind of KINDS) {
			const unchanged = await saveEntity(db, kind, ids[kind], ownerId, {
				...BASE,
				name: NAMES[kind],
				tags: []
			});
			expect(unchanged).toMatchObject({ ok: true, mentionsAffected: false });

			const renamed = await saveEntity(db, kind, ids[kind], ownerId, {
				...BASE,
				name: `${NAMES[kind]} II`,
				tags: []
			});
			expect(renamed).toMatchObject({ ok: true, mentionsAffected: true });

			const tagged = await saveEntity(db, kind, ids[kind], ownerId, {
				...BASE,
				name: `${NAMES[kind]} II`,
				tags: ['Sobriquet']
			});
			expect(tagged).toMatchObject({ ok: true, mentionsAffected: true });
		}
	});

	it('refuses a foreign story before writing anything', async () => {
		for (const kind of KINDS) {
			const result = await saveEntity(db, kind, ids[kind], ownerId, {
				...BASE,
				name: 'Renamed in vain',
				tags: [],
				storyId: crypto.randomUUID(),
				storyNotesMd: 'never lands'
			});
			expect(result).toMatchObject({ ok: false, reason: 'story not found' });
		}
		// Nothing persisted for any kind.
		const [character] = await db.select().from(characters).where(eq(characters.id, ids.character));
		expect(character.name).not.toBe('Renamed in vain');
	});

	it('refuses a blank name and an unknown category the same way', async () => {
		for (const kind of KINDS) {
			expect(
				await saveEntity(db, kind, ids[kind], ownerId, { ...BASE, name: '  ', tags: [] })
			).toMatchObject({ ok: false });
			expect(
				await saveEntity(db, kind, ids[kind], ownerId, {
					...BASE,
					name: NAMES[kind],
					tags: [],
					categoryId: crypto.randomUUID()
				})
			).toMatchObject({ ok: false, reason: 'category not found' });
		}
	});

	it('clears the category for characters and places but refuses it for lore', async () => {
		for (const kind of ['character', 'place'] as const) {
			const set = await saveEntity(db, kind, ids[kind], ownerId, {
				...BASE,
				name: NAMES[kind],
				tags: [],
				categoryId
			});
			expect(set).toMatchObject({ ok: true });
			const cleared = await saveEntity(db, kind, ids[kind], ownerId, {
				...BASE,
				name: NAMES[kind],
				tags: [],
				categoryId: null
			});
			expect(cleared).toMatchObject({ ok: true });
		}
		expect(
			await saveEntity(db, 'lore', ids.lore, ownerId, {
				...BASE,
				name: NAMES.lore,
				tags: [],
				categoryId: null
			})
		).toMatchObject({ ok: false, reason: 'a lore entry needs a category' });
		// The lore entry keeps its category.
		const [lore] = await db.select().from(loreEntries).where(eq(loreEntries.id, ids.lore));
		expect(lore.categoryId).toBe(categoryId);
	});

	it('hides everything from a non-owner', async () => {
		for (const kind of KINDS) {
			const result = await saveEntity(db, kind, ids[kind], crypto.randomUUID(), {
				...BASE,
				name: 'Thief',
				tags: []
			});
			expect(result).toMatchObject({ ok: false });
		}
	});
});
