import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Readable } from 'node:stream';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	backupKey,
	listRecentBackupRuns,
	runBackup,
	type BackupConfig,
	type BackupStore
} from '../../src/lib/server/backups';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;

const config: BackupConfig = {
	endpoint: undefined,
	region: 'auto',
	bucket: 'test',
	prefix: 'codex-backups',
	accessKeyId: 'id',
	secretAccessKey: 'secret',
	keepRecentHours: 48,
	keepDays: 30,
	cron: '0 * * * *'
};

// An in-memory bucket; the S3 client itself is thin SDK calls.
function memoryStore() {
	const objects = new Map<string, Buffer>();
	const store: BackupStore = {
		async put(key, body) {
			const chunks: Buffer[] = [];
			for await (const chunk of body) chunks.push(Buffer.from(chunk));
			objects.set(key, Buffer.concat(chunks));
		},
		async list() {
			return [...objects.keys()];
		},
		async remove(key) {
			objects.delete(key);
		},
		async get(key) {
			const data = objects.get(key);
			if (!data) throw new Error(`missing: ${key}`);
			return Readable.from(data);
		}
	};
	return { store, objects };
}

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
	await pool.query('truncate table backup_runs');
});

afterAll(async () => {
	await pool.end();
});

describe('runBackup', () => {
	it('dumps, uploads, records the run, and prunes by tier', async () => {
		const { store, objects } = memoryStore();
		const now = new Date('2026-06-04T12:00:00Z');
		// Beyond the recent window: two dumps on one old day (the newest of
		// them survives as that day's daily) and one ancient dump (pruned).
		await store.put(
			backupKey('codex-backups', new Date('2026-05-20T08:00:00Z')),
			Readable.from('a')
		);
		await store.put(
			backupKey('codex-backups', new Date('2026-05-20T20:00:00Z')),
			Readable.from('b')
		);
		await store.put(
			backupKey('codex-backups', new Date('2026-01-01T03:00:00Z')),
			Readable.from('c')
		);

		const result = await runBackup(db, 'manual', {
			config,
			store,
			databaseUrl: TEST_DATABASE_URL,
			dumpCommand: ['printf', 'fake-dump-bytes'],
			now
		});
		expect(result).toMatchObject({ ok: true, skipped: false });

		const [run] = await listRecentBackupRuns(db, 1);
		expect(run).toMatchObject({
			trigger: 'manual',
			status: 'ok',
			sizeBytes: 'fake-dump-bytes'.length
		});
		expect(run.contentHash).toMatch(/^[0-9a-f]{64}$/);
		expect(objects.get(run.objectKey!)?.toString()).toBe('fake-dump-bytes');

		expect([...objects.keys()].sort()).toEqual(
			[backupKey('codex-backups', new Date('2026-05-20T20:00:00Z')), run.objectKey].sort()
		);
	});

	it('skips the upload when nothing changed, and resumes when it does', async () => {
		const { store, objects } = memoryStore();
		const sizeBefore = objects.size;
		const again = await runBackup(db, 'scheduled', {
			config,
			store,
			databaseUrl: TEST_DATABASE_URL,
			dumpCommand: ['printf', 'fake-dump-bytes'],
			now: new Date('2026-06-04T13:00:00Z')
		});
		expect(again).toMatchObject({ ok: true, skipped: true, key: null });
		expect(objects.size).toBe(sizeBefore);
		const [skippedRun] = await listRecentBackupRuns(db, 1);
		expect(skippedRun).toMatchObject({ status: 'skipped', objectKey: null });

		const changed = await runBackup(db, 'scheduled', {
			config,
			store,
			databaseUrl: TEST_DATABASE_URL,
			dumpCommand: ['printf', 'different-bytes'],
			now: new Date('2026-06-04T14:00:00Z')
		});
		expect(changed).toMatchObject({ ok: true, skipped: false });
		expect(objects.size).toBe(sizeBefore + 1);
	});

	it('records a failure and uploads nothing', async () => {
		const { store, objects } = memoryStore();
		const result = await runBackup(db, 'scheduled', {
			config,
			store,
			databaseUrl: TEST_DATABASE_URL,
			dumpCommand: ['sh', '-c', 'printf partial; exit 3']
		});
		expect(result).toMatchObject({ ok: false });

		const [run] = await listRecentBackupRuns(db, 1);
		expect(run).toMatchObject({ trigger: 'scheduled', status: 'failed' });
		expect(run.error).toContain('exited with 3');
		expect(objects.size).toBe(0);
	});

	it('refuses politely when unconfigured', async () => {
		const result = await runBackup(db, 'manual', { config: null });
		expect(result).toMatchObject({ ok: false, reason: 'backups are not configured' });
	});
});

describe('pg_dump round trip', () => {
	it('dumps the real test database and pg_restore reads it back', async (context) => {
		// Needs a pg_dump whose major version can talk to the server; skip
		// quietly where the environment lacks it (CI installs it).
		const { execFile } = await import('node:child_process');
		const { promisify } = await import('node:util');
		const run = promisify(execFile);
		try {
			await run('pg_dump', ['--version']);
			await run('pg_restore', ['--version']);
		} catch {
			context.skip();
			return;
		}

		const { store, objects } = memoryStore();
		const result = await runBackup(db, 'manual', {
			config,
			store,
			databaseUrl: TEST_DATABASE_URL
		});
		if (!result.ok) {
			// A version mismatch (client older than server) is an environment
			// problem, not a code one; skip rather than fail.
			expect(result.reason).toMatch(/server version mismatch|aborting/);
			context.skip();
			return;
		}
		const dumpKey = result.key!;
		// A custom-format dump starts with the PGDMP magic bytes.
		expect(objects.get(dumpKey)?.subarray(0, 5).toString()).toBe('PGDMP');
		// pg_restore can list its table of contents, proving the archive is
		// readable end to end.
		const dumpFile = `${process.env.TMPDIR ?? '/tmp'}/codex-backup-test.dump`;
		const { writeFile, rm } = await import('node:fs/promises');
		await writeFile(dumpFile, objects.get(dumpKey)!);
		const { stdout } = await run('pg_restore', ['--list', dumpFile]);
		expect(stdout).toContain('TABLE DATA');
		await rm(dumpFile);
	});
});
