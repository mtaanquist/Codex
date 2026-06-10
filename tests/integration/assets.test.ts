import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Readable } from 'node:stream';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { universes, users } from '../../src/lib/server/db/schema';
import { eq } from 'drizzle-orm';
import {
	clearUserAvatar,
	createAsset,
	deleteAsset,
	openAsset,
	setUserAvatar,
	type AssetConfig,
	type AssetObjectStore
} from '../../src/lib/server/assets';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let strangerId: string;
let universeId: string;

const config: AssetConfig = {
	endpoint: undefined,
	region: 'auto',
	bucket: 'test',
	prefix: 'codex-assets',
	accessKeyId: 'id',
	secretAccessKey: 'secret'
};

function memoryStore() {
	const objects = new Map<string, { body: Buffer; contentType: string }>();
	const store: AssetObjectStore = {
		async put(key, body, contentType) {
			objects.set(key, { body, contentType });
		},
		async get(key) {
			const object = objects.get(key);
			if (!object) throw new Error(`missing: ${key}`);
			return Readable.from(object.body);
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
	await pool.query('truncate table assets, universes, users cascade');

	const [owner] = await db
		.insert(users)
		.values({ email: 'asset@example.com', displayName: 'A', passwordHash: 'x', role: 'user' })
		.returning();
	ownerId = owner.id;
	const [stranger] = await db
		.insert(users)
		.values({ email: 'asset2@example.com', displayName: 'B', passwordHash: 'x', role: 'user' })
		.returning();
	strangerId = stranger.id;
	const [universe] = await db.insert(universes).values({ ownerId, name: 'U' }).returning();
	universeId = universe.id;
});

afterAll(async () => {
	await pool.end();
});

describe('createAsset', () => {
	it('stores the object under the prefix and round-trips the bytes', async () => {
		const { store, objects } = memoryStore();
		const result = await createAsset(db, store, config, ownerId, {
			universeId,
			kind: 'inline',
			filename: 'gate.png',
			contentType: 'image/png',
			bytes: PNG
		});
		expect(result).toMatchObject({ ok: true });
		if (!result.ok) return;
		expect([...objects.keys()][0]).toBe(`codex-assets/${result.id}`);

		const opened = await openAsset(db, store, ownerId, result.id);
		expect(opened?.asset).toMatchObject({
			kind: 'inline',
			filename: 'gate.png',
			contentType: 'image/png',
			byteSize: PNG.length
		});
		const chunks: Buffer[] = [];
		for await (const chunk of opened!.body) chunks.push(Buffer.from(chunk));
		expect(Buffer.concat(chunks).equals(PNG)).toBe(true);

		// Another user can neither open nor delete it.
		expect(await openAsset(db, store, strangerId, result.id)).toBeNull();
		expect(await deleteAsset(db, store, strangerId, result.id)).toBe(false);
	});

	it('rejects unsupported types, empty files, oversize files, and foreign universes', async () => {
		const { store } = memoryStore();
		const base = {
			universeId,
			kind: 'inline' as const,
			filename: 'x',
			contentType: 'image/png',
			bytes: PNG
		};
		// Bytes that are not a recognised image are refused, whatever the
		// client-supplied content type claims (here a PNG label over plain text).
		expect(
			await createAsset(db, store, config, ownerId, {
				...base,
				bytes: Buffer.from('this is not an image')
			})
		).toMatchObject({ ok: false });
		expect(
			await createAsset(db, store, config, ownerId, { ...base, bytes: Buffer.alloc(0) })
		).toMatchObject({ ok: false });
		expect(
			await createAsset(db, store, config, ownerId, {
				...base,
				bytes: Buffer.alloc(10 * 1024 * 1024 + 1)
			})
		).toMatchObject({ ok: false });
		expect(await createAsset(db, store, config, strangerId, base)).toMatchObject({
			ok: false,
			reason: 'universe not found'
		});
	});
});

describe('avatars', () => {
	it('sets the avatar, replaces the previous one, and clears it', async () => {
		const { store, objects } = memoryStore();
		const first = await setUserAvatar(db, store, config, ownerId, {
			filename: 'me.png',
			contentType: 'image/png',
			bytes: PNG
		});
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		let [row] = await db.select().from(users).where(eq(users.id, ownerId));
		expect(row.avatarAssetId).toBe(first.id);
		expect(objects.size).toBe(1);

		// A second upload points the user at the new asset and drops the old one.
		const second = await setUserAvatar(db, store, config, ownerId, {
			filename: 'me2.png',
			contentType: 'image/png',
			bytes: PNG
		});
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		[row] = await db.select().from(users).where(eq(users.id, ownerId));
		expect(row.avatarAssetId).toBe(second.id);
		expect(objects.size).toBe(1);
		expect(await openAsset(db, store, ownerId, first.id)).toBeNull();

		await clearUserAvatar(db, store, ownerId);
		[row] = await db.select().from(users).where(eq(users.id, ownerId));
		expect(row.avatarAssetId).toBeNull();
		expect(objects.size).toBe(0);
	});

	it('does not orphan an asset when two uploads race', async () => {
		const { store, objects } = memoryStore();
		const [a, b] = await Promise.all([
			setUserAvatar(db, store, config, ownerId, {
				filename: 'a.png',
				contentType: 'image/png',
				bytes: PNG
			}),
			setUserAvatar(db, store, config, ownerId, {
				filename: 'b.png',
				contentType: 'image/png',
				bytes: PNG
			})
		]);
		expect(a.ok && b.ok).toBe(true);
		if (!a.ok || !b.ok) return;
		const [row] = await db.select().from(users).where(eq(users.id, ownerId));
		// One upload wins the row; the other's asset must be cleaned up, leaving
		// exactly one stored object rather than an orphan.
		expect([a.id, b.id]).toContain(row.avatarAssetId);
		expect(objects.size).toBe(1);
		const loser = row.avatarAssetId === a.id ? b.id : a.id;
		expect(await openAsset(db, store, ownerId, loser)).toBeNull();

		await clearUserAvatar(db, store, ownerId);
	});
});

describe('deleteAsset', () => {
	it('removes the row and the object', async () => {
		const { store, objects } = memoryStore();
		const created = await createAsset(db, store, config, ownerId, {
			universeId: null,
			kind: 'cover',
			filename: 'cover.png',
			contentType: 'image/png',
			bytes: PNG
		});
		if (!created.ok) throw new Error('setup failed');
		expect(await deleteAsset(db, store, ownerId, created.id)).toBe(true);
		expect(objects.size).toBe(0);
		expect(await openAsset(db, store, ownerId, created.id)).toBeNull();
	});
});
