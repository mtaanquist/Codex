import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
	universes,
	users
} from '../../src/lib/server/db/schema';
import {
	entityAliasColumn,
	entityNameColumn,
	namesByType,
	resolveOwnedEntity,
	type EntityTable
} from '../../src/lib/server/entity-lookups';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let strangerId: string;
let universeId: string;
let ids: { character: string; place: string; lore_entry: string };

const columns = (table: EntityTable) => ({
	universeId: table.universeId,
	name: entityNameColumn(table),
	tags: entityAliasColumn(table)
});

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query('truncate table characters, places, lore_entries, universes, users cascade');
	const [owner] = await db
		.insert(users)
		.values({ email: 'lookups@example.com', displayName: 'A', passwordHash: 'x', role: 'user' })
		.returning();
	ownerId = owner.id;
	const [stranger] = await db
		.insert(users)
		.values({ email: 'lookups2@example.com', displayName: 'B', passwordHash: 'x', role: 'user' })
		.returning();
	strangerId = stranger.id;
	const [universe] = await db.insert(universes).values({ ownerId, name: 'U' }).returning();
	universeId = universe.id;
	const [category] = await db
		.insert(entityCategories)
		.values({ universeId, ownerId, name: 'Lore', sortOrder: 0 })
		.returning();
	const [character] = await db
		.insert(characters)
		.values({ universeId, ownerId, name: 'Aria', aliases: ['Ari'] })
		.returning();
	const [place] = await db
		.insert(places)
		.values({ universeId, ownerId, name: 'Harbor', aliases: ['Docks'] })
		.returning();
	const [lore] = await db
		.insert(loreEntries)
		.values({
			universeId,
			ownerId,
			categoryId: category.id,
			title: 'The Accord',
			keywords: ['treaty']
		})
		.returning();
	ids = { character: character.id, place: place.id, lore_entry: lore.id };
});

afterAll(async () => {
	await pool.end();
});

describe('resolveOwnedEntity', () => {
	it('finds each entity type, reading lore title and keywords as name and tags', async () => {
		expect(await resolveOwnedEntity(db, ownerId, ids.character, columns)).toEqual({
			type: 'character',
			universeId,
			name: 'Aria',
			tags: ['Ari']
		});
		expect(await resolveOwnedEntity(db, ownerId, ids.place, columns)).toEqual({
			type: 'place',
			universeId,
			name: 'Harbor',
			tags: ['Docks']
		});
		expect(await resolveOwnedEntity(db, ownerId, ids.lore_entry, columns)).toEqual({
			type: 'lore_entry',
			universeId,
			name: 'The Accord',
			tags: ['treaty']
		});
	});

	it("does not resolve another user's entity", async () => {
		for (const id of Object.values(ids)) {
			expect(await resolveOwnedEntity(db, strangerId, id, columns)).toBeNull();
		}
	});

	it('does not resolve an entity whose universe is in the trash', async () => {
		await db.update(universes).set({ deletedAt: new Date() }).where(eq(universes.id, universeId));
		for (const id of Object.values(ids)) {
			expect(await resolveOwnedEntity(db, ownerId, id, columns)).toBeNull();
		}
	});
});

describe('namesByType', () => {
	it('maps ids to display names, using the title for lore', async () => {
		expect(await namesByType(db, 'character', [ids.character])).toEqual(
			new Map([[ids.character, 'Aria']])
		);
		expect(await namesByType(db, 'lore_entry', [ids.lore_entry])).toEqual(
			new Map([[ids.lore_entry, 'The Accord']])
		);
	});
});
