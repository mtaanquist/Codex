import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../src/lib/server/db/schema.ts';
import {
	backupConfig,
	effectiveBackupConfig,
	latestBackupKey,
	restoreDumpFile,
	s3Store
} from '../src/lib/server/backups.ts';

// Restores an off-site backup into DATABASE_URL.
// Usage: node scripts/restore-backup.ts <object key | latest>
//
// Stop the app and worker first; the restore drops and recreates the
// application tables. Existing data in the target database is replaced, in one
// transaction: if anything fails, the database is left as it was.
const [target] = process.argv.slice(2);
if (!target) {
	console.error('Usage: node scripts/restore-backup.ts <object key | latest>');
	process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://codex:codex@localhost:5432/codex';

// Use the same configuration the backup job uses: admin-panel settings win,
// the environment is the fallback (effectiveBackupConfig). Otherwise an
// instance configured purely through the panel would back up to one bucket and
// the restore would read another (or refuse). If the database is unreachable -
// the disaster-recovery case - fall back to the environment alone.
async function resolveConfig() {
	try {
		const pool = new pg.Pool({ connectionString: databaseUrl });
		const db = drizzle(pool, { schema });
		const config = await effectiveBackupConfig(db);
		await pool.end();
		if (config) {
			console.log(
				'Using the backup configuration from the database (or its environment fallback).'
			);
			return config;
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(
			`Could not read configuration from the database (${message}); ` +
				'falling back to the BACKUP_S3_* environment variables.'
		);
	}
	const config = backupConfig();
	if (config) {
		console.log('Using the backup configuration from the BACKUP_S3_* environment variables.');
	}
	return config;
}

const config = await resolveConfig();
if (!config) {
	console.error(
		'Backups are not configured; set them in the admin panel or the BACKUP_S3_* variables first.'
	);
	process.exit(1);
}
const store = s3Store(config);

let key = target;
if (target === 'latest') {
	const latest = latestBackupKey(await store.list());
	if (!latest) {
		console.error(`No backups found under ${config.prefix}/ in ${config.bucket}.`);
		process.exit(1);
	}
	key = latest;
}

console.log(`Restoring ${key} into ${databaseUrl.replace(/:[^:@/]+@/, ':***@')} ...`);
// Download in full before touching the database, so a dropped connection
// cannot leave a half-restored database behind.
const scratchDir = await mkdtemp(join(tmpdir(), 'codex-restore-'));
const dumpFile = join(scratchDir, 'backup.dump');
try {
	await pipeline(await store.get(key), createWriteStream(dumpFile));
	await restoreDumpFile(databaseUrl, dumpFile);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	console.error('The restore did not complete; the database was left unchanged.');
	process.exitCode = 1;
} finally {
	await rm(scratchDir, { recursive: true, force: true });
}
if (!process.exitCode) console.log('Restore complete. Start the app and worker again.');
