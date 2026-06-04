import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { hash } from '@node-rs/argon2';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

export const WORKER_PID_FILE = join(tmpdir(), 'codex-e2e-worker.pid');

// Migrates the database the preview server uses, seeds the user the e2e tests
// sign in with, and starts the worker so the mention index actually builds.
// Idempotent, so repeated local runs are fine.
export default async function globalSetup() {
	const worker = spawn(process.execPath, ['src/worker/index.ts'], {
		stdio: 'ignore',
		detached: true,
		env: process.env
	});
	worker.unref();
	writeFileSync(WORKER_PID_FILE, String(worker.pid));
	const connectionString =
		process.env.DATABASE_URL ?? 'postgres://codex:codex@localhost:5432/codex';
	const pool = new pg.Pool({ connectionString, max: 1 });
	await migrate(drizzle(pool), { migrationsFolder: 'drizzle' });
	const passwordHash = await hash('e2e-password', {
		memoryCost: 19456,
		timeCost: 2,
		parallelism: 1
	});
	await pool.query(
		`insert into users (email, display_name, password_hash, role, email_verified_at, approved_at, handle, public_archive_enabled)
		 values ($1, 'E2E Tester', $2, 'user', now(), now(), 'e2e-tester', true)
		 on conflict (email) do update set password_hash = excluded.password_hash,
		   handle = excluded.handle, public_archive_enabled = excluded.public_archive_enabled`,
		['e2e@example.com', passwordHash]
	);
	await pool.end();
}
