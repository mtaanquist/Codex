import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, isNull } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	characters,
	entityCategories,
	entityRelationships,
	places,
	relationTypes,
	revisions,
	universes,
	users
} from '../../src/lib/server/db/schema';
import {
	buildEntitySnapshot,
	createCheckpoint,
	getRevision,
	listRevisions,
	recordEntityRevision,
	restoreRevision
} from '../../src/lib/server/revisions';
import { createRelationship, deleteRelationship } from '../../src/lib/server/relationships';
import { saveCharacter } from '../../src/lib/server/characters';
import type { Database } from '../../src/lib/server/auth';
import { ensureBuiltInRelationTypes, ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

// Full-fidelity entity history: saves snapshot the structured fields, so
// changes beyond the body register in History, and Restore returns the
// whole entity.

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let universeId: string;
let aliceId: string;
let bramId: string;
let haldenId: string;
let categoryId: string;
let typeId: (key: string) => string;

async function latestSnapshot(type: 'character' | 'place', id: string) {
	const [row] = await listRevisions(db, type, id);
	const revision = await getRevision(db, row.id, type, id);
	return revision?.snapshot ?? null;
}

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
	await pool.query(
		'truncate table revisions, entity_relationships, entity_categories, places, characters, stories, universes, users cascade'
	);
	await ensureBuiltInRelationTypes(pool);

	const builtIns = await db.select().from(relationTypes).where(isNull(relationTypes.universeId));
	const byKey = new Map(builtIns.map((type) => [type.key, type.id]));
	typeId = (key: string) => {
		const id = byKey.get(key);
		if (!id) throw new Error(`missing built-in relation type ${key}`);
		return id;
	};

	const [owner] = await db
		.insert(users)
		.values({ email: 'hist@example.com', displayName: 'Hist', passwordHash: 'x', role: 'user' })
		.returning();
	ownerId = owner.id;
	const [universe] = await db.insert(universes).values({ ownerId, name: 'U' }).returning();
	universeId = universe.id;
	const [category] = await db
		.insert(entityCategories)
		.values({ universeId, ownerId, name: 'Crew', sortOrder: 0 })
		.returning();
	categoryId = category.id;
	const [alice] = await db
		.insert(characters)
		.values({ universeId, ownerId, name: 'Alice', bodyMd: 'A smuggler.' })
		.returning();
	aliceId = alice.id;
	const [bram] = await db
		.insert(characters)
		.values({ universeId, ownerId, name: 'Bram', bodyMd: 'A fence.' })
		.returning();
	bramId = bram.id;
	const [halden] = await db
		.insert(places)
		.values({ universeId, ownerId, name: 'Halden', bodyMd: 'A port.' })
		.returning();
	haldenId = halden.id;
});

afterAll(async () => {
	await pool.end();
});

describe('saves snapshot the structured fields', () => {
	it('a details-and-alias change registers without a body change', async () => {
		await saveCharacter(db, aliceId, ownerId, {
			name: 'Alice',
			aliases: ['Allie'],
			summaryMd: 'A smuggler with debts.',
			bodyMd: 'A smuggler.',
			details: [{ label: 'Status', value: 'Alive' }],
			categoryId
		});
		const [alice] = await db.select().from(characters).where(eq(characters.id, aliceId));
		expect(alice.details).toEqual([{ label: 'Status', value: 'Alive' }]);

		const snapshot = await latestSnapshot('character', aliceId);
		expect(snapshot).toMatchObject({
			name: 'Alice',
			aliases: ['Allie'],
			summaryMd: 'A smuggler with debts.',
			categoryId,
			categoryName: 'Crew',
			details: [{ label: 'Status', value: 'Alive' }]
		});
	});

	it('an unchanged save records nothing new', async () => {
		const before = await listRevisions(db, 'character', aliceId);
		await saveCharacter(db, aliceId, ownerId, {
			name: 'Alice',
			aliases: ['Allie'],
			summaryMd: 'A smuggler with debts.',
			bodyMd: 'A smuggler.',
			details: [{ label: 'Status', value: 'Alive' }],
			categoryId
		});
		const after = await listRevisions(db, 'character', aliceId);
		expect(after).toHaveLength(before.length);
		expect(after[0].id).toBe(before[0].id);
		expect(after[0].createdAt).toEqual(before[0].createdAt);
	});

	it('a checkpoint captures the full entity', async () => {
		const ok = await createCheckpoint(db, ownerId, 'character', aliceId, 'Cast settled');
		expect(ok).toMatchObject({ ok: true });
		const snapshot = await latestSnapshot('character', aliceId);
		expect(snapshot?.name).toBe('Alice');
		expect(snapshot?.details).toEqual([{ label: 'Status', value: 'Alive' }]);
	});
});

describe('relationship changes land on both timelines', () => {
	it('creating one records a revision for each end', async () => {
		const result = await createRelationship(db, ownerId, {
			fromKind: 'character',
			fromId: aliceId,
			relationTypeId: typeId('mentor_of'),
			toId: bramId,
			notesMd: 'Took him in.'
		});
		expect(result).toMatchObject({ ok: true });

		const aliceSnapshot = await latestSnapshot('character', aliceId);
		expect(aliceSnapshot?.relationships).toMatchObject([
			{ role: 'from', otherId: bramId, otherName: 'Bram', label: 'mentor of' }
		]);
		const bramSnapshot = await latestSnapshot('character', bramId);
		expect(bramSnapshot?.relationships).toMatchObject([
			{ role: 'to', otherId: aliceId, otherName: 'Alice', label: 'student of' }
		]);
	});

	it('deleting one records the emptied set on both ends', async () => {
		const [row] = await db
			.select({ id: entityRelationships.id })
			.from(entityRelationships)
			.where(eq(entityRelationships.universeId, universeId));
		expect(await deleteRelationship(db, row.id, ownerId)).toBe(true);
		expect((await latestSnapshot('character', aliceId))?.relationships).toEqual([]);
		expect((await latestSnapshot('character', bramId))?.relationships).toEqual([]);
	});
});

describe('restore returns the whole entity', () => {
	it('round-trips fields, details, and the relationship set', async () => {
		// The state to come back to: alias, details, category, one relationship.
		await createRelationship(db, ownerId, {
			fromKind: 'character',
			fromId: aliceId,
			relationTypeId: typeId('lives_in'),
			toId: haldenId
		});
		await createCheckpoint(db, ownerId, 'character', aliceId, 'Before the rewrite');
		const checkpoint = (await listRevisions(db, 'character', aliceId)).find(
			(row) => row.label === 'Before the rewrite'
		)!;

		// Then everything changes: name, aliases, summary, details, category
		// cleared, relationship replaced.
		await saveCharacter(db, aliceId, ownerId, {
			name: 'Alys',
			aliases: [],
			summaryMd: null,
			bodyMd: 'A captain now.',
			details: [{ label: 'Status', value: 'Missing' }],
			categoryId: null
		});
		const [relationship] = await db
			.select({ id: entityRelationships.id })
			.from(entityRelationships)
			.where(eq(entityRelationships.universeId, universeId));
		await deleteRelationship(db, relationship.id, ownerId);
		await createRelationship(db, ownerId, {
			fromKind: 'character',
			fromId: aliceId,
			relationTypeId: typeId('born_in'),
			toId: haldenId
		});

		const result = await restoreRevision(db, ownerId, checkpoint.id, 'character', aliceId);
		expect(result).toMatchObject({ ok: true, universeId, mentionsAffected: true });

		const [alice] = await db.select().from(characters).where(eq(characters.id, aliceId));
		expect(alice).toMatchObject({
			name: 'Alice',
			aliases: ['Allie'],
			summaryMd: 'A smuggler with debts.',
			bodyMd: 'A smuggler.',
			details: [{ label: 'Status', value: 'Alive' }],
			categoryId
		});
		const rows = await db
			.select()
			.from(entityRelationships)
			.where(eq(entityRelationships.universeId, universeId));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			relationTypeId: typeId('lives_in'),
			fromId: aliceId,
			toId: haldenId
		});

		// A 'restore' revision stacked on top, and the reshuffled relationship
		// registered on the place's timeline too.
		expect((await listRevisions(db, 'character', aliceId))[0].reason).toBe('restore');
		expect((await latestSnapshot('place', haldenId))?.relationships).toMatchObject([
			{ relationTypeId: typeId('lives_in'), role: 'to', otherId: aliceId }
		]);
	});

	it('skips snapshot parts that no longer exist', async () => {
		// Snapshot Alice while she points at a category and a place that are
		// both about to be deleted.
		await createCheckpoint(db, ownerId, 'character', aliceId, 'Doomed references');
		const checkpoint = (await listRevisions(db, 'character', aliceId)).find(
			(row) => row.label === 'Doomed references'
		)!;

		await db.delete(entityRelationships).where(eq(entityRelationships.universeId, universeId));
		await db.delete(places).where(eq(places.id, haldenId));
		await db.update(characters).set({ categoryId: null }).where(eq(characters.id, aliceId));
		await db.delete(entityCategories).where(eq(entityCategories.id, categoryId));

		const result = await restoreRevision(db, ownerId, checkpoint.id, 'character', aliceId);
		expect(result).toMatchObject({ ok: true });
		const [alice] = await db.select().from(characters).where(eq(characters.id, aliceId));
		// The deleted category stays unset; the relationship to the deleted
		// place is not recreated; the fields still restore.
		expect(alice.categoryId).toBeNull();
		expect(alice.name).toBe('Alice');
		const rows = await db
			.select()
			.from(entityRelationships)
			.where(eq(entityRelationships.universeId, universeId));
		expect(rows).toHaveLength(0);
	});

	it('restores body-only for revisions from before snapshots existed', async () => {
		await db.insert(revisions).values({
			entityType: 'character',
			entityId: aliceId,
			bodyMd: 'Old words only.',
			reason: 'checkpoint',
			label: 'Pre-snapshot row'
		});
		const old = (await listRevisions(db, 'character', aliceId)).find(
			(row) => row.label === 'Pre-snapshot row'
		)!;
		const result = await restoreRevision(db, ownerId, old.id, 'character', aliceId);
		expect(result).toMatchObject({ ok: true, mentionsAffected: false });
		const [alice] = await db.select().from(characters).where(eq(characters.id, aliceId));
		expect(alice.bodyMd).toBe('Old words only.');
		// Structured fields untouched.
		expect(alice.name).toBe('Alice');
		expect(alice.details).toEqual([{ label: 'Status', value: 'Alive' }]);
	});
});

describe('buildEntitySnapshot', () => {
	it('returns null for a missing entity', async () => {
		expect(await buildEntitySnapshot(db, 'place', aliceId)).toBeNull();
	});

	it('recordEntityRevision is a no-op for a missing entity', async () => {
		expect(await recordEntityRevision(db, 'place', aliceId)).toEqual({ recorded: false });
	});
});
