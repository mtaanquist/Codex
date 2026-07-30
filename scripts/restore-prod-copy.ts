import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

// Restores an off-site backup into a local throwaway database for development,
// then makes it safe to run against. Usage:
//   node scripts/restore-prod-copy.ts [object key | latest]
//
// A restored dump carries the source instance's service settings, and stored
// settings beat the environment, so an untreated copy points this machine at
// the real buckets and mail relay. Those rows are dropped here. Their secrets
// are encrypted with the source APP_SECRET anyway, and reading one without it
// throws rather than failing soft, which breaks every page that resolves asset
// storage.
const SERVICE_SETTINGS = ['asset-storage', 'smtp', 'backup-storage'];

const DEFAULT_TARGET = 'postgres://codex:codex@localhost:5432/codex_prod_copy';

// The BACKUP_S3_* credentials live in .env; load them so this runs without the
// caller exporting anything first. Variables already set in the shell win.
if (existsSync('.env')) process.loadEnvFile('.env');

const key = process.argv[2] ?? 'latest';
const target = process.env.PROD_COPY_DATABASE_URL ?? DEFAULT_TARGET;

if (process.env.APP_SECRET) {
	console.error(
		'APP_SECRET is set. Leave it unset for a local copy: it is what keeps the\n' +
			'restored SMTP and backup credentials unreadable, so this machine cannot\n' +
			'mail real users or write to the real backup bucket.'
	);
	process.exit(1);
}

// The restore pipes into pg_restore, which ships with the Postgres client
// tools rather than with Node. Say so here instead of failing mid-restore.
if (spawnSync('pg_restore', ['--version']).error) {
	console.error(
		'pg_restore is not on the PATH; install the Postgres client tools.\n' +
			'  macOS:  brew install libpq  (keg-only, so add its bin to the PATH)'
	);
	process.exit(1);
}

await ensureDatabase(target);

console.log(`Restoring ${key} into ${redact(target)} ...`);
await run(process.execPath, ['scripts/restore-backup.ts', key], { DATABASE_URL: target });

const pool = new pg.Pool({ connectionString: target, max: 1 });
const dropped = await pool.query(
	`delete from app_settings where key = any($1::text[]) returning key`,
	[SERVICE_SETTINGS]
);
console.log(
	dropped.rowCount
		? `Cleared service settings: ${dropped.rows.map((row) => row.key).join(', ')}.`
		: 'No service settings to clear.'
);

await migrate(drizzle(pool), { migrationsFolder: 'drizzle' });
await pool.end();
console.log('Migrations applied.');
console.log(`\nDone. Point the app and the worker at it together:\n  DATABASE_URL=${target}`);

// Creates the target database when it is missing, so a first run needs no
// manual setup. Connects to the server's own postgres database to do it.
async function ensureDatabase(connectionString: string) {
	const url = new URL(connectionString);
	const name = url.pathname.slice(1);
	url.pathname = '/postgres';
	const admin = new pg.Client({ connectionString: url.toString() });
	await admin.connect();
	try {
		const exists = await admin.query('select 1 from pg_database where datname = $1', [name]);
		if (exists.rowCount === 0) {
			await admin.query(`create database "${name}"`);
			console.log(`Created database ${name}.`);
		}
	} finally {
		await admin.end();
	}
}

function run(command: string, args: string[], env: Record<string, string>): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: 'inherit',
			env: { ...process.env, ...env }
		});
		child.on('error', reject);
		// The child has already printed why it failed, so carry its status up
		// rather than burying it under a stack trace from here.
		child.on('close', (code) => {
			if (code === 0) resolve();
			else process.exit(code ?? 1);
		});
	});
}

function redact(connectionString: string): string {
	return connectionString.replace(/:[^:@/]+@/, ':***@');
}
