import { spawn } from 'node:child_process';
import { backupConfig, s3Store } from '../src/lib/server/backups.ts';

// Restores an off-site backup into DATABASE_URL.
// Usage: node scripts/restore-backup.ts <object key | latest>
//
// Stop the app and worker first; the restore drops and recreates the
// application tables. Existing data in the target database is replaced.
const [target] = process.argv.slice(2);
if (!target) {
	console.error('Usage: node scripts/restore-backup.ts <object key | latest>');
	process.exit(1);
}

const config = backupConfig();
if (!config) {
	console.error('Backups are not configured; set the BACKUP_S3_* variables first.');
	process.exit(1);
}
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://codex:codex@localhost:5432/codex';
const store = s3Store(config);

let key = target;
if (target === 'latest') {
	const keys = (await store.list()).sort();
	if (keys.length === 0) {
		console.error(`No backups found under ${config.prefix}/ in ${config.bucket}.`);
		process.exit(1);
	}
	key = keys.at(-1)!;
}

console.log(`Restoring ${key} into ${databaseUrl.replace(/:[^:@/]+@/, ':***@')} ...`);
const body = await store.get(key);
const restore = spawn(
	'pg_restore',
	['--clean', '--if-exists', '--no-owner', '--dbname', databaseUrl],
	{ stdio: ['pipe', 'inherit', 'inherit'] }
);
body.pipe(restore.stdin);

const code: number = await new Promise((resolve, reject) => {
	restore.on('error', reject);
	restore.on('close', (exit) => resolve(exit ?? 1));
});
if (code !== 0) {
	console.error(`pg_restore exited with ${code}.`);
	process.exit(code);
}
console.log('Restore complete. Start the app and worker again.');
