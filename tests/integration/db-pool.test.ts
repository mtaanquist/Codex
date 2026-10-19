import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import pg from 'pg';
import { createPool } from '../../src/lib/server/db/pool';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool | undefined;

beforeAll(async () => {
	await ensureTestDatabase();
});

afterEach(async () => {
	await pool?.end();
	pool = undefined;
});

describe('createPool', () => {
	it('survives the server dropping an idle pooled connection', async () => {
		pool = createPool(TEST_DATABASE_URL);
		const { rows } = await pool.query<{ pid: number }>('select pg_backend_pid() as pid');
		// Stands in for a Postgres restart: kill the idle client's backend from
		// outside. No listener is attached here on purpose; without the pool's own
		// handler the 'error' event is unhandled and takes the process down.
		const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
		await admin.connect();
		await admin.query('select pg_terminate_backend($1)', [rows[0].pid]);
		await admin.end();
		await vi.waitFor(() => expect(pool!.totalCount).toBe(0));

		const after = await pool.query<{ ok: number }>('select 1 as ok');
		expect(after.rows[0].ok).toBe(1);
	});

	it('cancels a statement that runs past the timeout', async () => {
		pool = createPool(TEST_DATABASE_URL, { statementTimeoutMs: 100 });
		await expect(pool.query('select pg_sleep(2)')).rejects.toMatchObject({ code: '57014' });
	});
});
