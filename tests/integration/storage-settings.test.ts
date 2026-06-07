import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Readable } from 'node:stream';
import { Readable as ReadableStream } from 'node:stream';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { assets, users } from '../../src/lib/server/db/schema';
import {
	assetMigrationSource,
	assetStorageView,
	clearAssetMigrationSource,
	effectiveAssetConfig,
	migrateAssetObjects,
	saveAssetStorage,
	type AssetObjectStore
} from '../../src/lib/server/assets';
import {
	backupStorageView,
	effectiveBackupConfig,
	saveBackupStorage
} from '../../src/lib/server/backups';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;

const S3_ENV = [
	'ASSET_S3_ENDPOINT',
	'ASSET_S3_REGION',
	'ASSET_S3_BUCKET',
	'ASSET_S3_PREFIX',
	'ASSET_S3_ACCESS_KEY_ID',
	'ASSET_S3_SECRET_ACCESS_KEY',
	'BACKUP_S3_ENDPOINT',
	'BACKUP_S3_REGION',
	'BACKUP_S3_BUCKET',
	'BACKUP_S3_PREFIX',
	'BACKUP_S3_ACCESS_KEY_ID',
	'BACKUP_S3_SECRET_ACCESS_KEY',
	'BACKUP_KEEP_RECENT_HOURS',
	'BACKUP_KEEP_DAYS',
	'BACKUP_CRON'
];

const SAVE_INPUT = {
	endpoint: 'https://s3.example.test',
	region: 'eu-1',
	bucket: 'bucket-a',
	prefix: 'codex-assets',
	accessKeyId: 'key-id',
	secretAccessKey: 'very-secret'
};

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
	process.env.APP_SECRET = 'a-test-app-secret';
});

beforeEach(async () => {
	await pool.query('truncate table app_settings, assets, users cascade');
	for (const key of S3_ENV) delete process.env[key];
});

afterAll(async () => {
	await pool.end();
	delete process.env.APP_SECRET;
});

async function makeOwner(): Promise<string> {
	const [row] = await db
		.insert(users)
		.values({ email: 'o@example.com', displayName: 'O', passwordHash: 'x', role: 'user' })
		.returning({ id: users.id });
	return row.id;
}

async function insertAsset(ownerId: string, storageKey: string) {
	await db.insert(assets).values({
		ownerId,
		universeId: null,
		kind: 'inline',
		filename: 'pic.png',
		contentType: 'image/png',
		byteSize: 3,
		storageKey
	});
}

// An in-memory stand-in for the bucket, enough for the copy job.
function memoryStore(objects = new Map<string, Buffer>()): AssetObjectStore & {
	objects: Map<string, Buffer>;
} {
	return {
		objects,
		async put(key, body) {
			objects.set(key, body);
		},
		async get(key): Promise<Readable> {
			const body = objects.get(key);
			if (!body) throw new Error(`missing object: ${key}`);
			return ReadableStream.from(body);
		},
		async remove(key) {
			objects.delete(key);
		}
	};
}

describe('effectiveAssetConfig', () => {
	it('is null when neither the database nor the environment configures it', async () => {
		expect(await effectiveAssetConfig(db)).toBeNull();
		expect((await assetStorageView(db)).source).toBe('none');
	});

	it('falls back to the environment when nothing is saved', async () => {
		process.env.ASSET_S3_BUCKET = 'env-bucket';
		process.env.ASSET_S3_ACCESS_KEY_ID = 'env-key';
		process.env.ASSET_S3_SECRET_ACCESS_KEY = 'env-secret';
		const config = await effectiveAssetConfig(db);
		expect(config).toMatchObject({ bucket: 'env-bucket', secretAccessKey: 'env-secret' });
		expect((await assetStorageView(db)).source).toBe('environment');
	});

	it('prefers saved settings and decrypts the secret', async () => {
		process.env.ASSET_S3_BUCKET = 'env-bucket';
		process.env.ASSET_S3_ACCESS_KEY_ID = 'env-key';
		process.env.ASSET_S3_SECRET_ACCESS_KEY = 'env-secret';
		expect((await saveAssetStorage(db, SAVE_INPUT)).ok).toBe(true);
		const config = await effectiveAssetConfig(db);
		expect(config).toMatchObject({ bucket: 'bucket-a', secretAccessKey: 'very-secret' });
		const view = await assetStorageView(db);
		expect(view.source).toBe('database');
		// The view never carries the secret itself.
		expect(JSON.stringify(view)).not.toContain('very-secret');
	});

	it('keeps the stored secret when a blank one is submitted', async () => {
		await saveAssetStorage(db, SAVE_INPUT);
		await saveAssetStorage(db, { ...SAVE_INPUT, bucket: 'bucket-b', secretAccessKey: '' });
		expect(await effectiveAssetConfig(db)).toMatchObject({
			bucket: 'bucket-b',
			secretAccessKey: 'very-secret'
		});
	});

	it('rejects a missing bucket, key id, or first-time secret', async () => {
		expect((await saveAssetStorage(db, { ...SAVE_INPUT, bucket: ' ' })).ok).toBe(false);
		expect((await saveAssetStorage(db, { ...SAVE_INPUT, accessKeyId: '' })).ok).toBe(false);
		expect((await saveAssetStorage(db, { ...SAVE_INPUT, secretAccessKey: '' })).ok).toBe(false);
	});
});

describe('saveAssetStorage migration stash', () => {
	it('stashes the previous connection when a populated storage moves', async () => {
		const owner = await makeOwner();
		await insertAsset(owner, 'codex-assets/one');
		await saveAssetStorage(db, SAVE_INPUT);
		expect(await assetMigrationSource(db)).toBeNull();

		await saveAssetStorage(db, { ...SAVE_INPUT, bucket: 'bucket-b' });
		const source = await assetMigrationSource(db);
		expect(source).toMatchObject({ bucket: 'bucket-a', secretAccessKey: 'very-secret' });

		await clearAssetMigrationSource(db);
		expect(await assetMigrationSource(db)).toBeNull();
	});

	it('does not stash when nothing is stored or the bucket stays the same', async () => {
		// Empty instance: nothing to migrate.
		await saveAssetStorage(db, SAVE_INPUT);
		await saveAssetStorage(db, { ...SAVE_INPUT, bucket: 'bucket-b' });
		expect(await assetMigrationSource(db)).toBeNull();

		// Same bucket, only a credential rotation: nothing to migrate either.
		const owner = await makeOwner();
		await insertAsset(owner, 'codex-assets/one');
		await saveAssetStorage(db, { ...SAVE_INPUT, bucket: 'bucket-b', accessKeyId: 'new-key' });
		expect(await assetMigrationSource(db)).toBeNull();
	});
});

describe('migrateAssetObjects', () => {
	it('copies every known object and counts unreadable ones without stopping', async () => {
		const owner = await makeOwner();
		await insertAsset(owner, 'codex-assets/one');
		await insertAsset(owner, 'codex-assets/two');
		await insertAsset(owner, 'codex-assets/lost');

		const source = memoryStore(
			new Map([
				['codex-assets/one', Buffer.from('aaa')],
				['codex-assets/two', Buffer.from('bbb')]
			])
		);
		const target = memoryStore();

		const result = await migrateAssetObjects(db, source, target);
		expect(result).toEqual({ copied: 2, failed: 1 });
		expect(target.objects.get('codex-assets/one')?.toString()).toBe('aaa');
		expect(target.objects.get('codex-assets/two')?.toString()).toBe('bbb');
	});
});

describe('effectiveBackupConfig', () => {
	it('falls back to the environment and prefers saved settings', async () => {
		expect(await effectiveBackupConfig(db)).toBeNull();

		process.env.BACKUP_S3_BUCKET = 'env-backups';
		process.env.BACKUP_S3_ACCESS_KEY_ID = 'env-key';
		process.env.BACKUP_S3_SECRET_ACCESS_KEY = 'env-secret';
		expect(await effectiveBackupConfig(db)).toMatchObject({ bucket: 'env-backups' });
		expect((await backupStorageView(db)).source).toBe('environment');

		const saved = await saveBackupStorage(db, {
			...SAVE_INPUT,
			prefix: 'codex-backups',
			keepRecentHours: 12,
			keepDays: 7
		});
		expect(saved.ok).toBe(true);
		const config = await effectiveBackupConfig(db);
		expect(config).toMatchObject({
			bucket: 'bucket-a',
			secretAccessKey: 'very-secret',
			keepRecentHours: 12,
			keepDays: 7
		});
		// The cadence stays an operator concern.
		expect(config?.cron).toBe('0 * * * *');
		expect((await backupStorageView(db)).source).toBe('database');
	});

	it('rejects retention shorter than an hour or a day', async () => {
		const base = { ...SAVE_INPUT, prefix: 'codex-backups' };
		expect((await saveBackupStorage(db, { ...base, keepRecentHours: 0, keepDays: 7 })).ok).toBe(
			false
		);
		expect((await saveBackupStorage(db, { ...base, keepRecentHours: 12, keepDays: 0 })).ok).toBe(
			false
		);
	});
});
