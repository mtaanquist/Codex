import pg from 'pg';

export const TEST_DATABASE_URL =
	process.env.TEST_DATABASE_URL ?? 'postgres://codex:codex@localhost:5432/codex_test';

// The built-in relation types are seeded by migration 0008, but any test
// file that truncates universes with cascade wipes relation_types too (the
// FK pulls it into the cascade). Tests that need the built-ins call this
// after their truncate to restore them; the conflict target makes it a
// no-op when they survived.
export async function ensureBuiltInRelationTypes(pool: pg.Pool) {
	await pool.query(`
		INSERT INTO relation_types ("universe_id", "key", "forward_label", "reverse_label", "bidirectional", "from_type", "to_type", "category", "sort_order") VALUES
		(NULL, 'parent_of', 'parent of', 'child of', false, 'character', 'character', 'family', 0),
		(NULL, 'sibling_of', 'sibling of', NULL, true, 'character', 'character', 'family', 1),
		(NULL, 'spouse_of', 'spouse of', NULL, true, 'character', 'character', 'family', 2),
		(NULL, 'friend_of', 'friend of', NULL, true, 'character', 'character', 'social', 3),
		(NULL, 'rival_of', 'rival of', NULL, true, 'character', 'character', 'social', 4),
		(NULL, 'enemy_of', 'enemy of', NULL, true, 'character', 'character', 'social', 5),
		(NULL, 'ally_of', 'ally of', NULL, true, 'character', 'character', 'social', 6),
		(NULL, 'mentor_of', 'mentor of', 'student of', false, 'character', 'character', 'social', 7),
		(NULL, 'serves', 'serves', 'served by', false, 'character', 'character', 'social', 8),
		(NULL, 'born_in', 'born in', 'birthplace of', false, 'character', 'place', 'geography', 9),
		(NULL, 'raised_in', 'raised in', 'childhood home of', false, 'character', 'place', 'geography', 10),
		(NULL, 'lives_in', 'lives in', 'home of', false, 'character', 'place', 'geography', 11),
		(NULL, 'rules', 'rules', 'ruled by', false, 'character', 'place', 'geography', 12),
		(NULL, 'exiled_from', 'exiled from', 'has exiled', false, 'character', 'place', 'geography', 13),
		(NULL, 'part_of', 'part of', 'contains', false, 'place', 'place', 'geography', 14)
		ON CONFLICT ("universe_id", "key") DO NOTHING
	`);
}

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
