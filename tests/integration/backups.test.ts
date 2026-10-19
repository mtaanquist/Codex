import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Readable } from 'node:stream';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	backupKey,
	latestBackupKey,
	listRecentBackupRuns,
	restoreDumpFile,
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
			// The fake dump is not a real archive, so hash its bytes directly
			// rather than running the production pg_restore renderer over them.
			hashCommand: (scratch) => ['cat', scratch],
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
			hashCommand: (scratch) => ['cat', scratch],
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
			hashCommand: (scratch) => ['cat', scratch],
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
			await run('psql', ['--version']);
		} catch (error) {
			// CI installs the client tools; a skip there would hide a broken backup.
			if (process.env.CI) throw error;
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
			// problem, not a code one; skip rather than fail, except in CI.
			expect(result.reason).toMatch(/server version mismatch|aborting/);
			if (process.env.CI) throw new Error(result.reason);
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

		// Restored onto an empty database, the result must be able to take the
		// next backup: backup_runs keeps its definition even though its rows
		// are left out of the dump.
		const restoreUrl = new URL(TEST_DATABASE_URL);
		restoreUrl.pathname = `${restoreUrl.pathname}_restore`;
		const adminUrl = new URL(TEST_DATABASE_URL);
		adminUrl.pathname = '/postgres';
		const admin = new pg.Client({ connectionString: adminUrl.toString() });
		await admin.connect();
		const restoreName = restoreUrl.pathname.slice(1);
		try {
			await admin.query(`drop database if exists "${restoreName}"`);
			await admin.query(`create database "${restoreName}"`);
			await restoreDumpFile(restoreUrl.toString(), dumpFile);
			const restoredPool = new pg.Pool({ connectionString: restoreUrl.toString() });
			try {
				const restored = drizzle(restoredPool, { schema });
				const runs = await listRecentBackupRuns(restored, 5);
				expect(runs).toHaveLength(0);
				const again = await runBackup(restored, 'manual', {
					config,
					store: memoryStore().store,
					databaseUrl: restoreUrl.toString()
				});
				expect(again).toMatchObject({ ok: true });
				expect(await listRecentBackupRuns(restored, 5)).toHaveLength(1);

				// A dump from before the fix restored without the table while the
				// ledger listed it; the repair migration brings it back. Replay the
				// ledger up to the repair migration only, from a copy of the
				// migrations folder cut off there, so later migrations (which are
				// not idempotent) are not run a second time.
				await restoredPool.query('drop table backup_runs');
				const { mkdtemp, mkdir, readFile, copyFile } = await import('node:fs/promises');
				const journal = JSON.parse(await readFile('drizzle/meta/_journal.json', 'utf8')) as {
					entries: { tag: string; when: number }[];
				};
				const repairAt = journal.entries.findIndex(
					(entry) => entry.tag === '0068_restore-backup-runs'
				);
				expect(repairAt).toBeGreaterThan(-1);
				const upToRepair = journal.entries.slice(0, repairAt + 1);
				const cutFolder = await mkdtemp(`${process.env.TMPDIR ?? '/tmp'}/codex-migrations-`);
				await mkdir(`${cutFolder}/meta`);
				await writeFile(
					`${cutFolder}/meta/_journal.json`,
					JSON.stringify({ ...journal, entries: upToRepair })
				);
				for (const entry of upToRepair) {
					await copyFile(`drizzle/${entry.tag}.sql`, `${cutFolder}/${entry.tag}.sql`);
				}
				await restoredPool.query(
					'delete from drizzle.__drizzle_migrations where created_at >= $1',
					[journal.entries[repairAt].when]
				);
				await migrate(restored, { migrationsFolder: cutFolder });
				await rm(cutFolder, { recursive: true, force: true });
				expect(await listRecentBackupRuns(restored, 5)).toHaveLength(0);

				// Restoring over a database with a newer schema leaves nothing of
				// it behind, so the next migrate does not trip over a table the
				// restored ledger does not know about.
				await restoredPool.query('create table added_later (id int)');
				await restoreDumpFile(restoreUrl.toString(), dumpFile);
				const [{ later }] = (
					await restoredPool.query("select to_regclass('public.added_later') as later")
				).rows;
				expect(later).toBeNull();
				await migrate(restored, { migrationsFolder: 'drizzle' });

				// A broken dump leaves the database exactly as it was.
				const dump = objects.get(dumpKey)!;
				const broken = `${dumpFile}.broken`;
				await writeFile(broken, dump.subarray(0, Math.floor(dump.length * 0.9)));
				await restoredPool.query('create table kept (id int)');
				await expect(restoreDumpFile(restoreUrl.toString(), broken)).rejects.toThrow();
				await rm(broken, { force: true });
				const [{ kept }] = (await restoredPool.query("select to_regclass('public.kept') as kept"))
					.rows;
				expect(kept).not.toBeNull();

				// psql stopping early (here, a database that does not exist) fails
				// the restore instead of leaving pg_restore stuck on a full pipe. The
				// dump is made well past the pipe buffer so the stall would show.
				await restoredPool.query('insert into kept select g from generate_series(1, 200000) g');
				const big = `${dumpFile}.big`;
				await run('pg_dump', [
					'--format=custom',
					'--compress=0',
					'--file',
					big,
					restoreUrl.toString()
				]);
				const missingUrl = new URL(restoreUrl);
				missingUrl.pathname = `${restoreUrl.pathname}_missing`;
				await expect(restoreDumpFile(missingUrl.toString(), big)).rejects.toThrow(/psql exited/);
				await rm(big, { force: true });
			} finally {
				await restoredPool.end();
			}
		} finally {
			await admin.query(`drop database if exists "${restoreName}" with (force)`);
			await admin.end();
			await rm(dumpFile, { force: true });
		}

		// The real regression: a second backup of the unchanged database hashes
		// the same and skips the upload. The custom archive's header timestamp
		// (and the per-run backup_runs row) used to defeat this, so the skip
		// never fired in production. The database is quiescent during this test.
		const second = await runBackup(db, 'manual', {
			config,
			store,
			databaseUrl: TEST_DATABASE_URL
		});
		expect(second).toMatchObject({ ok: true, skipped: true, key: null });
		expect(objects.size).toBe(1);
	}, 60_000);
});

describe('latestBackupKey', () => {
	it('picks the newest real backup and ignores non-backup objects', () => {
		const older = backupKey('codex-backups', new Date('2026-06-01T01:00:00Z'));
		const newer = backupKey('codex-backups', new Date('2026-06-02T01:00:00Z'));
		// A leftover probe object sorts lexically after the codex- keys, so a
		// plain sort().at(-1) would wrongly pick it as latest.
		const probe = 'codex-backups/connection-probe';
		expect(latestBackupKey([older, probe, newer])).toBe(newer);
		expect(latestBackupKey([probe])).toBeNull();
		expect(latestBackupKey([])).toBeNull();
	});
});
