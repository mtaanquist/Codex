import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../src/lib/server/db/schema.ts';
import { runBackup } from '../src/lib/server/backups.ts';

// Runs one off-site backup right now, outside the worker's schedule.
// Usage: node scripts/run-backup.ts
const connectionString = process.env.DATABASE_URL ?? 'postgres://codex:codex@localhost:5432/codex';
const pool = new pg.Pool({ connectionString, max: 1 });
const db = drizzle(pool, { schema });

const result = await runBackup(db, 'manual');
await pool.end();
if (!result.ok) {
	console.error(`Backup failed: ${result.reason}`);
	process.exit(1);
}
console.log(result.skipped ? 'Backup skipped: nothing changed.' : `Backup uploaded: ${result.key}`);
