import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, eq, isNull } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	characters,
	entityRelationships,
	places,
	relationTypes,
	universes,
	users
} from '../../src/lib/server/db/schema';
import {
	createRelationship,
	deleteRelationship,
	listEntityRelationships,
	listRelationTypes
} from '../../src/lib/server/relationships';
import type { Database } from '../../src/lib/server/auth';
import { ensureBuiltInRelationTypes, ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let strangerId: string;
let universeId: string;
let aliceId: string;
let bramId: string;
let haldenId: string;
let foreignPlaceId: string;
let typeId: (key: string) => string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
	// Truncating universes cascades into relation_types (the FK pulls it
	// in), so the built-ins are restored right after.
	await pool.query(
		'truncate table entity_relationships, places, characters, stories, universes, users cascade'
	);
	await ensureBuiltInRelationTypes(pool);

	const builtIns = await db.select().from(relationTypes).where(isNull(relationTypes.universeId));
	expect(builtIns).toHaveLength(15);
	const byKey = new Map(builtIns.map((type) => [type.key, type.id]));
	typeId = (key: string) => {
		const id = byKey.get(key);
		if (!id) throw new Error(`missing built-in relation type ${key}`);
		return id;
	};

	const [owner] = await db
		.insert(users)
		.values({ email: 'rel@example.com', displayName: 'Rel', passwordHash: 'x', role: 'user' })
		.returning();
	ownerId = owner.id;
	const [stranger] = await db
		.insert(users)
		.values({ email: 'rel2@example.com', displayName: 'Rel2', passwordHash: 'x', role: 'user' })
		.returning();
	strangerId = stranger.id;
	const [universe] = await db.insert(universes).values({ ownerId, name: 'U' }).returning();
	universeId = universe.id;
	const [foreign] = await db.insert(universes).values({ ownerId, name: 'Elsewhere' }).returning();

	const [alice] = await db
		.insert(characters)
		.values({ universeId, ownerId, name: 'Alice' })
		.returning();
	aliceId = alice.id;
	const [bram] = await db
		.insert(characters)
		.values({ universeId, ownerId, name: 'Bram' })
		.returning();
	bramId = bram.id;
	const [halden] = await db
		.insert(places)
		.values({ universeId, ownerId, name: 'Halden' })
		.returning();
	haldenId = halden.id;
	const [foreignPlace] = await db
		.insert(places)
		.values({ universeId: foreign.id, ownerId, name: 'Yonder' })
		.returning();
	foreignPlaceId = foreignPlace.id;
});

afterAll(async () => {
	await pool.end();
});

describe('listRelationTypes', () => {
	it('returns the built-in library plus the universe own types', async () => {
		const builtInCount = (await listRelationTypes(db, universeId)).length;
		expect(builtInCount).toBe(15);

		await db.insert(relationTypes).values({
			universeId,
			key: 'sworn_sword_of',
			forwardLabel: 'sworn sword of',
			reverseLabel: 'liege of',
			fromType: 'character',
			toType: 'character',
			sortOrder: 100
		});
		const withCustom = await listRelationTypes(db, universeId);
		expect(withCustom).toHaveLength(16);
		expect(withCustom.at(-1)?.key).toBe('sworn_sword_of');

		// Another universe does not see it.
		const [other] = await db.insert(universes).values({ ownerId, name: 'Other' }).returning();
		expect(await listRelationTypes(db, other.id)).toHaveLength(15);
	});
});

describe('createRelationship', () => {
	it('creates a directional relation and rejects the exact duplicate', async () => {
		const created = await createRelationship(db, ownerId, {
			fromKind: 'character',
			fromId: aliceId,
			relationTypeId: typeId('lives_in'),
			toId: haldenId,
			notesMd: 'Since the toll war.'
		});
		expect(created).toMatchObject({ ok: true });

		const duplicate = await createRelationship(db, ownerId, {
			fromKind: 'character',
			fromId: aliceId,
			relationTypeId: typeId('lives_in'),
			toId: haldenId
		});
		expect(duplicate).toMatchObject({ ok: false, reason: 'that relationship already exists' });
	});

	it('rejects the swapped duplicate of a symmetric relation', async () => {
		const forward = await createRelationship(db, ownerId, {
			fromKind: 'character',
			fromId: aliceId,
			relationTypeId: typeId('rival_of'),
			toId: bramId
		});
		expect(forward).toMatchObject({ ok: true });
		const swapped = await createRelationship(db, ownerId, {
			fromKind: 'character',
			fromId: bramId,
			relationTypeId: typeId('rival_of'),
			toId: aliceId
		});
		expect(swapped).toMatchObject({ ok: false });
	});

	it('rejects a self-relationship', async () => {
		const result = await createRelationship(db, ownerId, {
			fromKind: 'character',
			fromId: aliceId,
			relationTypeId: typeId('rival_of'),
			toId: aliceId
		});
		expect(result).toMatchObject({ ok: false, reason: 'an entity cannot relate to itself' });
	});

	it('has a database unique index that blocks a duplicate universe-wide row', async () => {
		const values = {
			universeId,
			ownerId,
			fromType: 'character' as const,
			fromId: bramId,
			toType: 'place' as const,
			toId: haldenId,
			relationTypeId: typeId('lives_in')
		};
		await db.insert(entityRelationships).values(values);
		await expect(db.insert(entityRelationships).values(values)).rejects.toThrow();
		// Leave the fixture as the other tests expect it.
		await db
			.delete(entityRelationships)
			.where(
				and(
					eq(entityRelationships.fromId, bramId),
					eq(entityRelationships.toId, haldenId),
					eq(entityRelationships.relationTypeId, typeId('lives_in'))
				)
			);
	});

	it('rejects a relation that does not start from that kind', async () => {
		// part_of is place-to-place.
		const result = await createRelationship(db, ownerId, {
			fromKind: 'character',
			fromId: aliceId,
			relationTypeId: typeId('part_of'),
			toId: haldenId
		});
		expect(result).toMatchObject({ ok: false });
	});

	it('rejects a target of the wrong kind or another universe', async () => {
		const wrongKind = await createRelationship(db, ownerId, {
			fromKind: 'character',
			fromId: aliceId,
			relationTypeId: typeId('born_in'),
			toId: bramId
		});
		expect(wrongKind).toMatchObject({ ok: false, reason: 'target entity not found' });

		const foreign = await createRelationship(db, ownerId, {
			fromKind: 'character',
			fromId: aliceId,
			relationTypeId: typeId('born_in'),
			toId: foreignPlaceId
		});
		expect(foreign).toMatchObject({ ok: false, reason: 'target entity not found' });
	});

	it('rejects an entity the user does not own', async () => {
		const result = await createRelationship(db, strangerId, {
			fromKind: 'character',
			fromId: aliceId,
			relationTypeId: typeId('lives_in'),
			toId: haldenId
		});
		expect(result).toMatchObject({ ok: false, reason: 'entity not found' });
	});
});

describe('listEntityRelationships', () => {
	it('renders forward on the source and reverse on the target', async () => {
		const fromAlice = await listEntityRelationships(db, universeId, {
			kind: 'character',
			id: aliceId
		});
		const livesIn = fromAlice.find((rel) => rel.label === 'lives in');
		expect(livesIn).toMatchObject({
			otherType: 'place',
			otherId: haldenId,
			otherName: 'Halden',
			notesMd: 'Since the toll war.'
		});

		const fromHalden = await listEntityRelationships(db, universeId, {
			kind: 'place',
			id: haldenId
		});
		expect(fromHalden).toHaveLength(1);
		expect(fromHalden[0]).toMatchObject({ label: 'home of', otherName: 'Alice' });
	});

	it('renders a symmetric relation with the same label on both ends', async () => {
		const fromAlice = await listEntityRelationships(db, universeId, {
			kind: 'character',
			id: aliceId
		});
		expect(fromAlice.find((rel) => rel.otherId === bramId)?.label).toBe('rival of');
		const fromBram = await listEntityRelationships(db, universeId, {
			kind: 'character',
			id: bramId
		});
		expect(fromBram.find((rel) => rel.otherId === aliceId)?.label).toBe('rival of');
	});
});

describe('deleteRelationship', () => {
	it('removes own rows and refuses others', async () => {
		const fromAlice = await listEntityRelationships(db, universeId, {
			kind: 'character',
			id: aliceId
		});
		const target = fromAlice[0];
		expect(await deleteRelationship(db, target.id, strangerId)).toBe(false);
		expect(await deleteRelationship(db, target.id, ownerId)).toBe(true);
		const after = await listEntityRelationships(db, universeId, {
			kind: 'character',
			id: aliceId
		});
		expect(after.find((rel) => rel.id === target.id)).toBeUndefined();
	});
});
