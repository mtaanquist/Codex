import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	characters,
	characterStoryMemberships,
	entityCategories,
	loreEntries,
	placeStoryMemberships,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import { createStoryEntity, ENTITY_NAME_MAX } from '../../src/lib/server/create-entity';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let universeId: string;
let storyId: string;
let loreCategoryId: string;
let spellsCategoryId: string;

function scope() {
	return { universeId, ownerId, storyId };
}

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
	await pool.query(
		'truncate table character_story_memberships, place_story_memberships, lore_entries, places, characters, entity_categories, stories, universes, users cascade'
	);

	const [owner] = await db
		.insert(users)
		.values({ email: 'sel@example.com', displayName: 'S', passwordHash: 'x', role: 'user' })
		.returning();
	ownerId = owner.id;
	const [universe] = await db.insert(universes).values({ ownerId, name: 'U' }).returning();
	universeId = universe.id;
	const [story] = await db.insert(stories).values({ universeId, ownerId, title: 'S' }).returning();
	storyId = story.id;
	const [second] = await db
		.insert(entityCategories)
		.values({ universeId, ownerId, name: 'Spells', sortOrder: 5 })
		.returning();
	spellsCategoryId = second.id;
	const [first] = await db
		.insert(entityCategories)
		.values({ universeId, ownerId, name: 'Lore', sortOrder: 0 })
		.returning();
	loreCategoryId = first.id;
});

afterAll(async () => {
	await pool.end();
});

describe('createStoryEntity', () => {
	it('creates a character and declares it a story member', async () => {
		const result = await createStoryEntity(db, scope(), 'character', '  Veylan  Storm ');
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const [row] = await db.select().from(characters).where(eq(characters.id, result.id));
		// Whitespace collapses: a selection can span a line break.
		expect(row.name).toBe('Veylan Storm');
		const memberships = await db
			.select()
			.from(characterStoryMemberships)
			.where(eq(characterStoryMemberships.characterId, result.id));
		expect(memberships).toHaveLength(1);
		expect(memberships[0].storyId).toBe(storyId);
	});

	it('creates a place with membership', async () => {
		const result = await createStoryEntity(db, scope(), 'place', 'The Sunken Quay');
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const memberships = await db
			.select()
			.from(placeStoryMemberships)
			.where(eq(placeStoryMemberships.placeId, result.id));
		expect(memberships).toHaveLength(1);
	});

	it('files a lore entry under the first category by sort order', async () => {
		const result = await createStoryEntity(db, scope(), 'lore_entry', 'The Long Night');
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const [row] = await db.select().from(loreEntries).where(eq(loreEntries.id, result.id));
		expect(row.title).toBe('The Long Night');
		expect(row.categoryId).toBe(loreCategoryId);
	});

	it('files a lore entry under the named category, refusing a foreign one', async () => {
		const result = await createStoryEntity(
			db,
			scope(),
			'lore_entry',
			'Featherfall',
			spellsCategoryId
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const [row] = await db.select().from(loreEntries).where(eq(loreEntries.id, result.id));
		expect(row.categoryId).toBe(spellsCategoryId);

		// A category from another universe (or none at all) does not pass.
		const [other] = await db.insert(universes).values({ ownerId, name: 'Other' }).returning();
		const [foreign] = await db
			.insert(entityCategories)
			.values({ universeId: other.id, ownerId, name: 'Foreign', sortOrder: 0 })
			.returning();
		const refused = await createStoryEntity(db, scope(), 'lore_entry', 'Trespass', foreign.id);
		expect(refused).toMatchObject({ ok: false });
	});

	it('rejects an empty or overlong selection', async () => {
		expect(await createStoryEntity(db, scope(), 'character', '   ')).toMatchObject({ ok: false });
		expect(
			await createStoryEntity(db, scope(), 'character', 'x'.repeat(ENTITY_NAME_MAX + 1))
		).toMatchObject({ ok: false });
	});

	it('lore fails plainly when the universe has no categories', async () => {
		const [bare] = await db.insert(universes).values({ ownerId, name: 'Bare' }).returning();
		const [bareStory] = await db
			.insert(stories)
			.values({ universeId: bare.id, ownerId, title: 'B' })
			.returning();
		const result = await createStoryEntity(
			db,
			{ universeId: bare.id, ownerId, storyId: bareStory.id },
			'lore_entry',
			'Orphan'
		);
		expect(result).toMatchObject({ ok: false });
	});
});
