import { spawn } from 'node:child_process';
import { openSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { hash } from '@node-rs/argon2';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

export const WORKER_PID_FILE = join(tmpdir(), 'codex-e2e-worker.pid');
export const WORKER_LOG_FILE = join(tmpdir(), 'codex-e2e-worker.log');

// The worker logs this once pg-boss has started and the queues are registered.
const WORKER_READY_MARKER = 'Worker started';
const WORKER_READY_TIMEOUT_MS = 30_000;

function workerIsReady(): boolean {
	try {
		return readFileSync(WORKER_LOG_FILE, 'utf8').includes(WORKER_READY_MARKER);
	} catch {
		return false; // log file not written yet
	}
}

// Migrates the database the preview server uses, seeds the user the e2e tests
// sign in with, and starts the worker so the mention index actually builds.
// Idempotent, so repeated local runs are fine.
export default async function globalSetup() {
	// Capture the worker's output to a file rather than discarding it, so we can
	// wait for it to come up and so a CI failure leaves something to read.
	const log = openSync(WORKER_LOG_FILE, 'w');
	const worker = spawn(process.execPath, ['src/worker/index.ts'], {
		stdio: ['ignore', log, log],
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

	// Do not start the tests until the worker is actually processing jobs.
	// Otherwise a slow worker start on a loaded runner looks like a missing
	// mention index and fails the find-usages assertions intermittently.
	const deadline = Date.now() + WORKER_READY_TIMEOUT_MS;
	while (!workerIsReady() && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	if (!workerIsReady()) {
		console.warn(
			`worker did not report ready within ${WORKER_READY_TIMEOUT_MS}ms; see ${WORKER_LOG_FILE}`
		);
	}
}
