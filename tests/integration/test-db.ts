import pg from 'pg';

export const TEST_DATABASE_URL =
	process.env.TEST_DATABASE_URL ?? 'postgres://codex:codex@localhost:5432/codex_test';

// Create the throwaway test database if it is missing, so the suite runs
// against any Postgres the environment provides without extra setup. Every
// integration test file calls this in beforeAll; test files run serially
// (see vite.config.ts), so there is no creation race.
export async function ensureTestDatabase() {
	const url = new URL(TEST_DATABASE_URL);
	const dbName = url.pathname.slice(1);
	url.pathname = '/postgres';
	const admin = new pg.Client({ connectionString: url.toString() });
	await admin.connect();
	try {
		const exists = await admin.query('select 1 from pg_database where datname = $1', [dbName]);
		if (exists.rowCount === 0) {
			await admin.query(`create database "${dbName}"`);
		}
	} finally {
		await admin.end();
	}
}
