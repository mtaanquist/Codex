import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	assets,
	characters,
	entityCategories,
	entityRelationships,
	exportArtifacts,
	publications,
	relationTypes,
	revisions,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import {
	destroyUniverse,
	listTrashedUniverses,
	listUniversesDueForPurge,
	restoreUniverse,
	trashUniverse,
	universeAssetKeys
} from '../../src/lib/server/universe-lifecycle';
import { ownedStory } from '../../src/lib/server/story-access';
import { ownedUniverse } from '../../src/lib/server/universe-access';
import { searchAll } from '../../src/lib/server/search';
import { recordRevision } from '../../src/lib/server/revisions';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let strangerId: string;
let universeId: string;
let storyId: string;
let characterId: string;
let typeId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
	await pool.query('truncate table users cascade');

	const [owner] = await db
		.insert(users)
		.values({ email: 'uni@example.com', displayName: 'U', passwordHash: 'x', role: 'user' })
		.returning();
	ownerId = owner.id;
	const [stranger] = await db
		.insert(users)
		.values({ email: 'uni2@example.com', displayName: 'U2', passwordHash: 'x', role: 'user' })
		.returning();
	strangerId = stranger.id;

	const [universe] = await db
		.insert(universes)
		.values({ ownerId, name: 'Closing Time', slug: 'closing-time' })
		.returning();
	universeId = universe.id;
	const [story] = await db
		.insert(stories)
		.values({ universeId, ownerId, title: 'Last Orders', slug: 'last-orders' })
		.returning();
	storyId = story.id;
	await db
		.insert(scenes)
		.values({ storyId, globalPosition: 1, title: 'Bell', bodyMd: 'The bell rang.' });
	const [category] = await db
		.insert(entityCategories)
		.values({ universeId, ownerId, name: 'Lore', sortOrder: 0 })
		.returning();
	const [character] = await db
		.insert(characters)
		.values({ universeId, ownerId, name: 'Mara', categoryId: category.id })
		.returning();
	characterId = character.id;
	await recordRevision(db, 'character', characterId, 'A barkeep.');
	const [relType] = await db
		.insert(relationTypes)
		.values({
			universeId,
			key: 'patron-of',
			forwardLabel: 'patron of',
			fromType: 'character',
			toType: 'place'
		})
		.returning();
	typeId = relType.id;
});

afterAll(async () => {
	await pool.end();
});

describe('trash and restore', () => {
	it('a trashed universe leaves every resolver and search', async () => {
		expect(await trashUniverse(db, strangerId, universeId)).toBe(false);
		expect(await trashUniverse(db, ownerId, universeId)).toBe(true);

		await expect(ownedUniverse('closing-time', ownerId, db)).rejects.toMatchObject({
			status: 404
		});
		await expect(ownedStory('last-orders', ownerId, db)).rejects.toMatchObject({ status: 404 });
		expect(await searchAll(db, ownerId, 'Mara')).toEqual([]);
		expect(await searchAll(db, ownerId, 'bell')).toEqual([]);

		const trashed = await listTrashedUniverses(db, ownerId);
		expect(trashed.map((row) => row.id)).toEqual([universeId]);
		expect(trashed[0].daysLeft).toBe(30);
	});

	it('is not due for the purge until the window elapses', async () => {
		expect(await listUniversesDueForPurge(db)).toEqual([]);
		await db
			.update(universes)
			.set({ deletedAt: sql`now() - interval '31 days'` })
			.where(eq(universes.id, universeId));
		expect(await listUniversesDueForPurge(db)).toEqual([universeId]);
	});

	it('restore brings everything back whole', async () => {
		expect(await restoreUniverse(db, ownerId, universeId)).toBe(true);
		expect((await ownedUniverse('closing-time', ownerId, db)).id).toBe(universeId);
		expect((await ownedStory('last-orders', ownerId, db)).story.id).toBe(storyId);
		expect((await searchAll(db, ownerId, 'Mara')).length).toBeGreaterThan(0);
		expect(await restoreUniverse(db, ownerId, universeId)).toBe(false);
	});
});

describe('universeAssetKeys', () => {
	it('includes uploaded images and the editions stored export files', async () => {
		const [asset] = await db
			.insert(assets)
			.values({
				ownerId,
				universeId,
				kind: 'inline',
				filename: 'x.png',
				contentType: 'image/png',
				byteSize: 1,
				storageKey: 'img-key'
			})
			.returning();
		const [pub] = await db
			.insert(publications)
			.values({ storyId, ownerId, handle: 'h', title: 'Ed', content: {}, isCurrent: true })
			.returning();
		await db.insert(exportArtifacts).values({
			publicationId: pub.id,
			format: 'epub',
			storageKey: 'epub-key',
			filename: 'e.epub',
			contentType: 'application/epub+zip',
			byteSize: 20
		});

		const keys = await universeAssetKeys(db, universeId);
		expect(keys).toContain('img-key');
		expect(keys).toContain('epub-key');

		// Leave the universe as the later destroy test expects it.
		await db.delete(exportArtifacts).where(eq(exportArtifacts.publicationId, pub.id));
		await db.delete(publications).where(eq(publications.id, pub.id));
		await db.delete(assets).where(eq(assets.id, asset.id));
	});
});

describe('destroy', () => {
	it('refuses a live universe, then purges a trashed one completely', async () => {
		expect((await destroyUniverse(db, ownerId, universeId)).ok).toBe(false);
		await trashUniverse(db, ownerId, universeId);
		expect((await destroyUniverse(db, strangerId, universeId)).ok).toBe(false);
		expect((await destroyUniverse(db, ownerId, universeId)).ok).toBe(true);

		expect(await db.select().from(universes).where(eq(universes.id, universeId))).toHaveLength(0);
		expect(await db.select().from(stories).where(eq(stories.id, storyId))).toHaveLength(0);
		expect(await db.select().from(characters).where(eq(characters.id, characterId))).toHaveLength(
			0
		);
		// The pieces the old account purge leaked: custom relation types and
		// entity history.
		expect(await db.select().from(relationTypes).where(eq(relationTypes.id, typeId))).toHaveLength(
			0
		);
		expect(
			await db.select().from(revisions).where(eq(revisions.entityId, characterId))
		).toHaveLength(0);
		expect(
			await db
				.select()
				.from(entityRelationships)
				.where(eq(entityRelationships.universeId, universeId))
		).toHaveLength(0);
	});
});
