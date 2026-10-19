import pg from 'pg';
import { logEvent } from '../log.ts';

// Shared by the app and the worker (which imports it with a .ts extension, so
// keep imports here relative and extension-qualified).

export type PoolOptions = {
	// Postgres cancels any single statement that runs longer than this. Lock
	// waits count, so a stuck advisory lock frees its connection instead of
	// holding it forever.
	statementTimeoutMs?: number;
};

export function createPool(
	connectionString: string | undefined,
	options: PoolOptions = {}
): pg.Pool {
	const pool = new pg.Pool({
		connectionString,
		// A request waiting for a free or new connection fails after this
		// instead of queueing forever when the pool is exhausted or the server
		// is unreachable.
		connectionTimeoutMillis: 5_000,
		statement_timeout: options.statementTimeoutMs ?? 30_000
	});
	// An idle client whose connection drops (a Postgres restart or failover)
	// emits 'error' on the pool. Unhandled, that crashes the process; the pool
	// has already discarded the client and opens a fresh one on the next query.
	pool.on('error', (error: Error & { code?: string }) => {
		logEvent('error', 'db.pool_error', { message: error.message, code: error.code });
	});
	return pool;
}
