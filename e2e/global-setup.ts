import { spawn } from 'node:child_process';
import { openSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { hash } from '@node-rs/argon2';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { ensureBuiltInRelationTypes, ensureTestDatabase } from '../tests/integration/test-db';
import { checkoutId } from '../tests/checkout-id';
import { e2eDatabaseUrl } from './database';

// Named for this checkout: two worktrees running at once would otherwise
// overwrite each other's pid file (so teardown kills the wrong worker) and
// share the log the readiness check reads, letting one run start on the other's
// "Worker started".
export const WORKER_PID_FILE = join(tmpdir(), `codex-e2e-worker-${checkoutId()}.pid`);
export const WORKER_LOG_FILE = join(tmpdir(), `codex-e2e-worker-${checkoutId()}.log`);

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
	// Start the worker the same way the app does (see package.json) so the
	// module resolution hook is active; the worker imports app modules that use
	// the $lib alias and extensionless paths.
	const worker = spawn(
		process.execPath,
		['--import', './src/worker/register.js', 'src/worker/index.ts'],
		{
			stdio: ['ignore', log, log],
			detached: true,
			// The worker has its own default database; point it at the suite's, or
			// it processes the jobs of whatever else is running.
			env: { ...process.env, DATABASE_URL: e2eDatabaseUrl() }
		}
	);
	worker.unref();
	writeFileSync(WORKER_PID_FILE, String(worker.pid));
	const databaseUrl = e2eDatabaseUrl();
	await ensureTestDatabase(databaseUrl);
	const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
	await migrate(drizzle(pool), { migrationsFolder: 'drizzle' });

	// Start from an empty workspace. The specs do not clean up after themselves,
	// and the cost of that only shows up much later, as a slow dashboard and
	// assertions that miss their timeout. Cascading takes the built-in relation
	// types with it (they hang off universes by a nullable key), so put them
	// back; the accounts below are untouched, nothing points users at universes.
	await pool.query('truncate universes cascade');
	await ensureBuiltInRelationTypes(pool);
	const passwordHash = await hash('e2e-password', {
		memoryCost: 19456,
		timeCost: 2,
		parallelism: 1
	});
	await pool.query(
		`insert into users (email, display_name, password_hash, role, email_verified_at, approved_at, handle, public_archive_enabled, invite_allowance)
		 values ($1, 'E2E Tester', $2, 'user', now(), now(), 'e2e-tester', true, 5)
		 on conflict (email) do update set password_hash = excluded.password_hash,
		   handle = excluded.handle, public_archive_enabled = excluded.public_archive_enabled,
		   invite_allowance = excluded.invite_allowance`,
		['e2e@example.com', passwordHash]
	);
	// The account-invites spec spends and revokes invites; clearing the unused
	// ones keeps repeated runs at the same starting point.
	await pool.query(
		`delete from invite_codes where used_count = 0
		 and created_by = (select id from users where email = 'e2e@example.com')`
	);
	// A separate account for the two-factor journey, so toggling 2FA there never
	// trips the password-only sign-ins the other specs rely on.
	await pool.query(
		`insert into users (email, display_name, password_hash, role, email_verified_at, approved_at)
		 values ($1, '2FA Tester', $2, 'user', now(), now())
		 on conflict (email) do update set password_hash = excluded.password_hash`,
		['tfa-e2e@example.com', passwordHash]
	);
	// A separate account for the passkey journey, kept clean of credentials so
	// the register-then-sign-in flow starts fresh every run.
	await pool.query(
		`insert into users (email, display_name, password_hash, role, email_verified_at, approved_at)
		 values ($1, 'Passkey Tester', $2, 'user', now(), now())
		 on conflict (email) do update set password_hash = excluded.password_hash`,
		['passkey-e2e@example.com', passwordHash]
	);
	await pool.query(
		`delete from webauthn_credentials where user_id = (select id from users where email = $1)`,
		['passkey-e2e@example.com']
	);
	// A standing invite code for the invited sign-up journey; resetting the use
	// count keeps repeated runs valid.
	await pool.query(
		`insert into invite_codes (code, label, max_uses, used_count)
		 values ('E2EI-NVIT-CODE', 'e2e tests', 5, 0)
		 on conflict (code) do update set used_count = 0, max_uses = 5, expires_at = null`
	);
	// Clear any two-factor left over from a previous run so the journey starts
	// from "off" every time.
	await pool.query(
		`delete from totp_recovery_codes where user_id = (select id from users where email = $1)`,
		['tfa-e2e@example.com']
	);
	await pool.query(
		`delete from user_totp where user_id = (select id from users where email = $1)`,
		['tfa-e2e@example.com']
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
