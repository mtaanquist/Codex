import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Readable } from 'node:stream';
import { and, eq } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { assets, characters, universes, users } from '../../src/lib/server/db/schema';
import {
	clearEntityBadgeImage,
	setEntityBadgeColor,
	setEntityBadgeImage
} from '../../src/lib/server/entity-badge';
import type { AssetConfig, AssetObjectStore } from '../../src/lib/server/assets';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let strangerId: string;
let universeId: string;
let characterId: string;

const config: AssetConfig = {
	endpoint: undefined,
	region: 'auto',
	bucket: 'test',
	prefix: 'codex-assets',
	accessKeyId: 'id',
	secretAccessKey: 'secret'
};

function memoryStore() {
	const objects = new Map<string, Buffer>();
	const store: AssetObjectStore = {
		async put(key, body) {
			objects.set(key, body as Buffer);
		},
		async get(key) {
			const body = objects.get(key);
			if (!body) throw new Error(`missing: ${key}`);
			return Readable.from(body);
		},
		async remove(key) {
			objects.delete(key);
		}
	};
	return { store, objects };
}

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query('truncate table assets, characters, universes, users cascade');
	const [owner] = await db
		.insert(users)
		.values({ email: 'badge@example.com', displayName: 'A', passwordHash: 'x', role: 'user' })
		.returning();
	ownerId = owner.id;
	const [stranger] = await db
		.insert(users)
		.values({ email: 'badge2@example.com', displayName: 'B', passwordHash: 'x', role: 'user' })
		.returning();
	strangerId = stranger.id;
	const [universe] = await db.insert(universes).values({ ownerId, name: 'U' }).returning();
	universeId = universe.id;
	const [character] = await db
		.insert(characters)
		.values({ universeId, ownerId, name: 'Aria' })
		.returning();
	characterId = character.id;
});

afterAll(async () => {
	await pool.end();
});

describe('setEntityBadgeColor', () => {
	it('sets a palette colour and clears it with null', async () => {
		expect((await setEntityBadgeColor(db, ownerId, characterId, 'var(--cat-red)')).ok).toBe(true);
		let [row] = await db.select().from(characters).where(eq(characters.id, characterId));
		expect(row.badgeColor).toBe('var(--cat-red)');

		expect((await setEntityBadgeColor(db, ownerId, characterId, null)).ok).toBe(true);
		[row] = await db.select().from(characters).where(eq(characters.id, characterId));
		expect(row.badgeColor).toBeNull();
	});

	it('rejects a colour outside the palette', async () => {
		const result = await setEntityBadgeColor(db, ownerId, characterId, 'red');
		expect(result.ok).toBe(false);
	});

	it('does not touch an entity owned by someone else', async () => {
		const result = await setEntityBadgeColor(db, strangerId, characterId, 'var(--cat-red)');
		expect(result.ok).toBe(false);
		const [row] = await db.select().from(characters).where(eq(characters.id, characterId));
		expect(row.badgeColor).toBeNull();
	});
});

describe('badge image', () => {
	it('uploads an image, replaces it, and removes it - cleaning up the old asset', async () => {
		const { store, objects } = memoryStore();
		const first = await setEntityBadgeImage(db, store, config, ownerId, characterId, {
			filename: 'a.png',
			contentType: 'image/png',
			bytes: PNG
		});
		expect(first.ok).toBe(true);
		let [row] = await db.select().from(characters).where(eq(characters.id, characterId));
		expect(row.badgeAssetId).toBe(first.ok && first.id);
		expect(objects.size).toBe(1);

		// A second upload swaps the reference and deletes the first object.
		const second = await setEntityBadgeImage(db, store, config, ownerId, characterId, {
			filename: 'b.png',
			contentType: 'image/png',
			bytes: PNG
		});
		expect(second.ok).toBe(true);
		[row] = await db.select().from(characters).where(eq(characters.id, characterId));
		expect(row.badgeAssetId).toBe(second.ok && second.id);
		expect(objects.size).toBe(1);
		if (first.ok) {
			const [oldAsset] = await db.select().from(assets).where(eq(assets.id, first.id));
			expect(oldAsset).toBeUndefined();
		}

		// Removing clears the reference and deletes the object.
		expect((await clearEntityBadgeImage(db, store, ownerId, characterId)).ok).toBe(true);
		[row] = await db.select().from(characters).where(eq(characters.id, characterId));
		expect(row.badgeAssetId).toBeNull();
		expect(objects.size).toBe(0);
		const remaining = await db
			.select()
			.from(assets)
			.where(and(eq(assets.ownerId, ownerId)));
		expect(remaining).toHaveLength(0);
	});
});
