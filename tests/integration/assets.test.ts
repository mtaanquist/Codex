import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Readable } from 'node:stream';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { assets, pendingObjectDeletions, universes, users } from '../../src/lib/server/db/schema';
import { eq } from 'drizzle-orm';
import {
	clearUserAvatar,
	createAsset,
	deleteAsset,
	objectDeletionGraceDays,
	ObjectNotFoundError,
	openAsset,
	scheduleObjectDeletions,
	setUserAvatar,
	sweepDeletedObjects,
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
		async upload(key, body, contentType) {
			const parts: Buffer[] = [];
			for await (const chunk of body) parts.push(Buffer.from(chunk));
			objects.set(key, { body: Buffer.concat(parts), contentType });
		},
		async get(key) {
			const object = objects.get(key);
			if (!object) throw new ObjectNotFoundError(key);
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
	await pool.query('truncate table assets, pending_object_deletions, universes, users cascade');

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
		expect(await deleteAsset(db, strangerId, result.id)).toBe(false);
	});

	it('opens to null when the row exists but its object is gone from the bucket', async () => {
		const { store, objects } = memoryStore();
		const result = await createAsset(db, store, config, ownerId, {
			universeId,
			kind: 'inline',
			filename: 'lost.png',
			contentType: 'image/png',
			bytes: PNG
		});
		if (!result.ok) throw new Error('upload failed');
		objects.clear();
		expect(await openAsset(db, store, ownerId, result.id)).toBeNull();
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
			code: 'not_found'
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

		// A second upload points the user at the new asset and drops the old row;
		// the old object waits for the deferred sweep.
		const second = await setUserAvatar(db, store, config, ownerId, {
			filename: 'me2.png',
			contentType: 'image/png',
			bytes: PNG
		});
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		[row] = await db.select().from(users).where(eq(users.id, ownerId));
		expect(row.avatarAssetId).toBe(second.id);
		expect(await openAsset(db, store, ownerId, first.id)).toBeNull();
		expect(await pendingKeys()).toContain(`codex-assets/${first.id}`);

		await clearUserAvatar(db, ownerId);
		[row] = await db.select().from(users).where(eq(users.id, ownerId));
		expect(row.avatarAssetId).toBeNull();
		expect(await pendingKeys()).toContain(`codex-assets/${second.id}`);
		expect(objects.size).toBe(2);
	});

	it('does not orphan an asset when two uploads race', async () => {
		const { store } = memoryStore();
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
		// One upload wins the row; the other's asset must be cleaned up (its
		// object queued for removal) rather than left as an orphan.
		expect([a.id, b.id]).toContain(row.avatarAssetId);
		const loser = row.avatarAssetId === a.id ? b.id : a.id;
		expect(await openAsset(db, store, ownerId, loser)).toBeNull();
		expect(await pendingKeys()).toContain(`codex-assets/${loser}`);
		expect(await pendingKeys()).not.toContain(`codex-assets/${row.avatarAssetId}`);

		await clearUserAvatar(db, ownerId);
	});
});

describe('deleteAsset', () => {
	it('removes the row at once and queues the object for the sweep', async () => {
		const { store, objects } = memoryStore();
		const created = await createAsset(db, store, config, ownerId, {
			universeId: null,
			kind: 'cover',
			filename: 'cover.png',
			contentType: 'image/png',
			bytes: PNG
		});
		if (!created.ok) throw new Error('setup failed');
		expect(await deleteAsset(db, ownerId, created.id)).toBe(true);
		expect(await openAsset(db, store, ownerId, created.id)).toBeNull();
		// The object survives, so a restored dump that still has the row works.
		expect(objects.has(`codex-assets/${created.id}`)).toBe(true);
		expect(await pendingKeys()).toContain(`codex-assets/${created.id}`);
	});
});

describe('sweepDeletedObjects', () => {
	async function queueAged(key: string, daysAgo: number) {
		await scheduleObjectDeletions(db, [key]);
		await db
			.update(pendingObjectDeletions)
			.set({ deletedAt: new Date(Date.now() - daysAgo * 86_400_000) })
			.where(eq(pendingObjectDeletions.storageKey, key));
	}

	it('removes objects past the grace period and keeps newer ones', async () => {
		await db.delete(pendingObjectDeletions);
		const { store, objects } = memoryStore();
		await store.put('old', PNG, 'image/png');
		await store.put('new', PNG, 'image/png');
		await queueAged('old', 40);
		await queueAged('new', 5);

		expect(await sweepDeletedObjects(db, store, 31)).toEqual({ removed: 1, kept: 0, failed: 0 });
		expect(objects.has('old')).toBe(false);
		expect(objects.has('new')).toBe(true);
		expect(await pendingKeys()).toEqual(['new']);
	});

	it('leaves a failed removal queued for the next sweep', async () => {
		await db.delete(pendingObjectDeletions);
		const { store } = memoryStore();
		const failing: AssetObjectStore = {
			...store,
			async remove() {
				throw new Error('bucket unreachable');
			}
		};
		await queueAged('stuck', 40);
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(await sweepDeletedObjects(db, failing, 31)).toEqual({
			removed: 0,
			kept: 0,
			failed: 1
		});
		expect(errors).toHaveBeenCalled();
		errors.mockRestore();
		expect(await pendingKeys()).toEqual(['stuck']);
	});

	it('unqueues, without removing, an object a row points at again', async () => {
		await db.delete(pendingObjectDeletions);
		const { store, objects } = memoryStore();
		const created = await createAsset(db, store, config, ownerId, {
			universeId: null,
			kind: 'inline',
			filename: 'back.png',
			contentType: 'image/png',
			bytes: PNG
		});
		if (!created.ok) throw new Error('setup failed');
		const [row] = await db.select().from(assets).where(eq(assets.id, created.id));
		await queueAged(row.storageKey, 40);

		expect(await sweepDeletedObjects(db, store, 31)).toEqual({ removed: 0, kept: 1, failed: 0 });
		expect(objects.has(row.storageKey)).toBe(true);
		expect(await pendingKeys()).toEqual([]);
	});

	it('waits one day past the backup retention, or one day without backups', () => {
		expect(objectDeletionGraceDays({ keepDays: 30, keepRecentHours: 48 })).toBe(31);
		// The hourly window can outlast the daily one.
		expect(objectDeletionGraceDays({ keepDays: 3, keepRecentHours: 168 })).toBe(8);
		expect(objectDeletionGraceDays(null)).toBe(1);
	});

	it('works through a backlog larger than one batch', async () => {
		await db.delete(pendingObjectDeletions);
		const { store } = memoryStore();
		const keys = Array.from({ length: 2500 }, (_, i) => `bulk-${String(i).padStart(5, '0')}`);
		await scheduleObjectDeletions(db, keys);
		await db
			.update(pendingObjectDeletions)
			.set({ deletedAt: new Date(Date.now() - 40 * 86_400_000) });
		expect(await sweepDeletedObjects(db, store, 31)).toEqual({
			removed: 2500,
			kept: 0,
			failed: 0
		});
		expect(await pendingKeys()).toEqual([]);
	});
});

async function pendingKeys() {
	const rows = await db
		.select({ storageKey: pendingObjectDeletions.storageKey })
		.from(pendingObjectDeletions);
	return rows.map((row) => row.storageKey).sort();
}
