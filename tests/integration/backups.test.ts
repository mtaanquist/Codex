import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Readable } from 'node:stream';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
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
	keep: 2,
	cron: '0 3 * * *'
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
	it('dumps, uploads, records the run, and prunes beyond retention', async () => {
		const { store, objects } = memoryStore();
		// Pre-existing old dumps; keep=2 means only the newest survives
		// alongside the run that is about to land.
		await store.put('codex-backups/codex-2026-01-01.dump', Readable.from('old-1'));
		await store.put('codex-backups/codex-2026-01-02.dump', Readable.from('old-2'));

		const result = await runBackup(db, 'manual', {
			config,
			store,
			databaseUrl: TEST_DATABASE_URL,
			dumpCommand: ['printf', 'fake-dump-bytes'],
			now: new Date('2026-06-04T03:00:00Z')
		});
		expect(result).toMatchObject({ ok: true });

		const [run] = await listRecentBackupRuns(db, 1);
		expect(run).toMatchObject({
			trigger: 'manual',
			status: 'ok',
			sizeBytes: 'fake-dump-bytes'.length
		});
		expect(run.objectKey).toContain('2026-06-04');
		expect(objects.get(run.objectKey!)?.toString()).toBe('fake-dump-bytes');

		// keep=2: the new dump plus the newest old one survive.
		expect([...objects.keys()].sort()).toEqual([
			'codex-backups/codex-2026-01-02.dump',
			run.objectKey
		]);
	});

	it('records a failure and removes the truncated object', async () => {
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
		const key = [...objects.keys()][0];
		// A custom-format dump starts with the PGDMP magic bytes.
		expect(objects.get(key)?.subarray(0, 5).toString()).toBe('PGDMP');
		// pg_restore can list its table of contents, proving the archive is
		// readable end to end.
		const dumpFile = `${process.env.TMPDIR ?? '/tmp'}/codex-backup-test.dump`;
		const { writeFile, rm } = await import('node:fs/promises');
		await writeFile(dumpFile, objects.get(key)!);
		const { stdout } = await run('pg_restore', ['--list', dumpFile]);
		expect(stdout).toContain('TABLE DATA');
		await rm(dumpFile);
	});
});
