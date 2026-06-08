import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, eq, isNull } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	characters,
	entityCategories,
	places,
	relationTypes,
	universes,
	users
} from '../../src/lib/server/db/schema';
import { createRelationship } from '../../src/lib/server/relationships';
import { getEntityCard } from '../../src/lib/server/plan-data';
import type { Database } from '../../src/lib/server/auth';
import { ensureBuiltInRelationTypes, ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

// The read-only entity card resolves an entity by id, owner-scoped, with its
// category, details, and typed relationships.

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let strangerId: string;
let bramId: string;
let aliceId: string;
let haldenId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
	await pool.query(
		'truncate table entity_relationships, entity_categories, places, characters, universes, users cascade'
	);
	await ensureBuiltInRelationTypes(pool);

	const [owner] = await db
		.insert(users)
		.values({ email: 'card@example.com', displayName: 'Card', passwordHash: 'x', role: 'user' })
		.returning();
	ownerId = owner.id;
	const [stranger] = await db
		.insert(users)
		.values({ email: 'other@example.com', displayName: 'Other', passwordHash: 'x', role: 'user' })
		.returning();
	strangerId = stranger.id;

	const [universe] = await db.insert(universes).values({ ownerId, name: 'U' }).returning();
	const universeId = universe.id;
	const [category] = await db
		.insert(entityCategories)
		.values({ universeId, ownerId, name: 'Crew', sortOrder: 0 })
		.returning();
	const [bram] = await db
		.insert(characters)
		.values({
			universeId,
			ownerId,
			name: 'Bram',
			aliases: ['the boy'],
			summaryMd: "Alice's outrider.",
			bodyMd: 'Bram joined the caravan at fifteen.',
			categoryId: category.id,
			details: [
				{ label: 'Age', value: '19' },
				{ label: 'Status', value: 'Alive' }
			]
		})
		.returning();
	bramId = bram.id;
	const [alice] = await db
		.insert(characters)
		.values({ universeId, ownerId, name: 'Alice', bodyMd: 'A smuggler.' })
		.returning();
	aliceId = alice.id;
	const [halden] = await db
		.insert(places)
		.values({ universeId, ownerId, name: 'Halden', bodyMd: 'A port.' })
		.returning();
	haldenId = halden.id;

	// A character-to-character and a character-to-place relationship from Bram.
	const [charToChar] = await db
		.select()
		.from(relationTypes)
		.where(
			and(
				isNull(relationTypes.universeId),
				eq(relationTypes.fromType, 'character'),
				eq(relationTypes.toType, 'character')
			)
		);
	const [charToPlace] = await db
		.select()
		.from(relationTypes)
		.where(
			and(
				isNull(relationTypes.universeId),
				eq(relationTypes.fromType, 'character'),
				eq(relationTypes.toType, 'place')
			)
		);
	const r1 = await createRelationship(db, ownerId, {
		fromKind: 'character',
		fromId: bramId,
		toId: aliceId,
		relationTypeId: charToChar.id,
		notesMd: ''
	});
	const r2 = await createRelationship(db, ownerId, {
		fromKind: 'character',
		fromId: bramId,
		toId: haldenId,
		relationTypeId: charToPlace.id,
		notesMd: ''
	});
	expect(r1.ok && r2.ok).toBe(true);
});

afterAll(async () => {
	await pool.end();
});

describe('getEntityCard', () => {
	it('returns the entity with its category, details, and relationships', async () => {
		const card = await getEntityCard(db, ownerId, bramId);
		expect(card).not.toBeNull();
		expect(card).toMatchObject({
			id: bramId,
			kind: 'character',
			name: 'Bram',
			categoryName: 'Crew',
			aliases: ['the boy'],
			summaryMd: "Alice's outrider.",
			details: [
				{ label: 'Age', value: '19' },
				{ label: 'Status', value: 'Alive' }
			]
		});
		expect(card!.bodyMd).toContain('Bram joined the caravan');

		// Both relationships surface, each with a label and the right kind.
		const related = card!.related;
		expect(related).toHaveLength(2);
		const alice = related.find((r) => r.id === aliceId);
		const halden = related.find((r) => r.id === haldenId);
		expect(alice).toMatchObject({ name: 'Alice', kind: 'character' });
		expect(halden).toMatchObject({ name: 'Halden', kind: 'place' });
		expect(alice!.label.length).toBeGreaterThan(0);
	});

	it('a place resolves with its kind', async () => {
		const card = await getEntityCard(db, ownerId, haldenId);
		expect(card).toMatchObject({ id: haldenId, kind: 'place', name: 'Halden' });
	});

	it("does not return another owner's entity", async () => {
		expect(await getEntityCard(db, strangerId, bramId)).toBeNull();
	});

	it('returns null for an unknown id', async () => {
		expect(await getEntityCard(db, ownerId, '00000000-0000-0000-0000-000000000000')).toBeNull();
	});
});
