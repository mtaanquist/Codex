import { beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { readJournal, runMigrations } from '../../src/lib/server/db/migrate';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

// A database of its own, emptied before the run, so concurrent first-time
// migration starts from nothing. Emptying the schemas is much cheaper than
// dropping and recreating the database, which forces a checkpoint.
const url = new URL(TEST_DATABASE_URL);
url.pathname = `${url.pathname}_migrate`;
const MIGRATE_DATABASE_URL = url.toString();

async function query(text: string) {
	const client = new pg.Client({ connectionString: MIGRATE_DATABASE_URL });
	await client.connect();
	try {
		return await client.query(text);
	} finally {
		await client.end();
	}
}

beforeAll(async () => {
	await ensureTestDatabase(MIGRATE_DATABASE_URL);
	await query(
		'drop schema if exists drizzle cascade; drop schema public cascade; create schema public'
	);
}, 30_000);

describe('runMigrations', () => {
	it('applies each migration once when several processes start together', async () => {
		await Promise.all([
			runMigrations(MIGRATE_DATABASE_URL),
			runMigrations(MIGRATE_DATABASE_URL),
			runMigrations(MIGRATE_DATABASE_URL)
		]);

		const { rows } = await query('select count(*)::int as n from drizzle.__drizzle_migrations');
		expect(rows[0].n).toBe(readJournal('drizzle').length);
	}, 30_000);
});
