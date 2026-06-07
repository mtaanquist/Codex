import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	characters,
	entityCategories,
	entityMentions,
	loreEntries,
	places,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import {
	entityAppearances,
	planEntityLists,
	resolvePlanEntity
} from '../../src/lib/server/plan-data';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let universeId: string;
let foreignUniverseId: string;
let storyOneId: string;
let storyTwoId: string;
let aliceId: string;
let haldenId: string;
let tollPassId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
	await pool.query(
		'truncate table entity_mentions, scenes, chapters, lore_entries, places, characters, entity_categories, stories, universes, users cascade'
	);

	const [owner] = await db
		.insert(users)
		.values({ email: 'plan@example.com', displayName: 'Plan', passwordHash: 'x', role: 'user' })
		.returning();
	const [universe] = await db
		.insert(universes)
		.values({ ownerId: owner.id, name: 'U' })
		.returning();
	universeId = universe.id;
	const [foreign] = await db
		.insert(universes)
		.values({ ownerId: owner.id, name: 'Elsewhere' })
		.returning();
	foreignUniverseId = foreign.id;

	const [category] = await db
		.insert(entityCategories)
		.values({ universeId, ownerId: owner.id, name: 'Lore', color: 'var(--cat-blue)', sortOrder: 0 })
		.returning();
	const [alice] = await db
		.insert(characters)
		.values({ universeId, ownerId: owner.id, name: 'Alice', categoryId: category.id })
		.returning();
	aliceId = alice.id;
	const [halden] = await db
		.insert(places)
		.values({ universeId, ownerId: owner.id, name: 'Halden' })
		.returning();
	haldenId = halden.id;
	const [tollPass] = await db
		.insert(loreEntries)
		.values({ universeId, ownerId: owner.id, categoryId: category.id, title: 'Toll-pass' })
		.returning();
	tollPassId = tollPass.id;

	// Two stories with one scene each; Alice is mentioned in both, the place
	// in one. positionInSeries puts story two first to prove the ordering.
	const [storyOne] = await db
		.insert(stories)
		.values({ universeId, ownerId: owner.id, title: 'Book one', positionInSeries: 2 })
		.returning();
	storyOneId = storyOne.id;
	const [storyTwo] = await db
		.insert(stories)
		.values({ universeId, ownerId: owner.id, title: 'Book two', positionInSeries: 1 })
		.returning();
	storyTwoId = storyTwo.id;
	const [sceneOne] = await db
		.insert(scenes)
		.values({ storyId: storyOneId, globalPosition: 1, bodyMd: 'Alice at the gate.' })
		.returning();
	const [sceneTwo] = await db
		.insert(scenes)
		.values({ storyId: storyTwoId, globalPosition: 1, bodyMd: 'Alice rides for Halden.' })
		.returning();
	await db.insert(entityMentions).values([
		{
			sourceType: 'scene',
			sourceId: sceneOne.id,
			targetType: 'character',
			targetId: aliceId,
			position: 0,
			surroundingText: 'Alice at the gate.'
		},
		{
			sourceType: 'scene',
			sourceId: sceneTwo.id,
			targetType: 'character',
			targetId: aliceId,
			position: 0,
			surroundingText: 'Alice rides for Halden.'
		},
		{
			sourceType: 'scene',
			sourceId: sceneTwo.id,
			targetType: 'place',
			targetId: haldenId,
			position: 16,
			surroundingText: 'Alice rides for Halden.'
		}
	]);
});

afterAll(async () => {
	await pool.end();
});

describe('planEntityLists', () => {
	it('lists each kind with category colours joined in', async () => {
		const lists = await planEntityLists(db, universeId);
		expect(lists.characters).toEqual([{ id: aliceId, name: 'Alice', color: 'var(--cat-blue)' }]);
		expect(lists.places).toEqual([{ id: haldenId, name: 'Halden', color: null }]);
		expect(lists.lore.map((entry) => entry.name)).toEqual(['Toll-pass']);
		expect(lists.categories).toHaveLength(1);
	});

	it('returns empty lists for a universe with no entities', async () => {
		const lists = await planEntityLists(db, foreignUniverseId);
		expect(lists.characters).toEqual([]);
		expect(lists.places).toEqual([]);
		expect(lists.lore).toEqual([]);
	});
});

describe('resolvePlanEntity', () => {
	it('resolves a character, a place, and a lore entry by id', async () => {
		expect(await resolvePlanEntity(db, universeId, aliceId)).toMatchObject({
			kind: 'character',
			entity: { id: aliceId, name: 'Alice' }
		});
		expect(await resolvePlanEntity(db, universeId, haldenId)).toMatchObject({
			kind: 'place',
			entity: { id: haldenId, name: 'Halden' }
		});
		// Lore exposes its title as "name" for the shared editor.
		expect(await resolvePlanEntity(db, universeId, tollPassId)).toMatchObject({
			kind: 'lore',
			entity: { id: tollPassId, name: 'Toll-pass', title: 'Toll-pass' }
		});
	});

	it('does not resolve an entity through another universe', async () => {
		expect(await resolvePlanEntity(db, foreignUniverseId, aliceId)).toBeNull();
	});

	it('returns null for an unknown id', async () => {
		expect(await resolvePlanEntity(db, universeId, crypto.randomUUID())).toBeNull();
	});
});

describe('entityAppearances', () => {
	it('scopes to one story', async () => {
		const rows = await entityAppearances(
			db,
			{ kind: 'character', id: aliceId },
			{ storyId: storyOneId }
		);
		expect(rows).toHaveLength(1);
		// position rides along so the appears-in panel can link to the spot.
		expect(rows[0]).toMatchObject({ storyId: storyOneId, storyTitle: 'Book one', position: 0 });
	});

	it('spans every story at universe scope, in series order', async () => {
		const rows = await entityAppearances(db, { kind: 'character', id: aliceId }, { universeId });
		expect(rows.map((row) => row.storyTitle)).toEqual(['Book two', 'Book one']);
	});

	it('maps the lore kind onto the lore_entry target type', async () => {
		// No lore mentions indexed, so the proof is an empty result rather
		// than a query error or a cross-kind match.
		const rows = await entityAppearances(db, { kind: 'lore', id: tollPassId }, { universeId });
		expect(rows).toEqual([]);
		const placeRows = await entityAppearances(db, { kind: 'place', id: haldenId }, { universeId });
		expect(placeRows).toHaveLength(1);
		expect(placeRows[0].position).toBe(16);
	});
});
