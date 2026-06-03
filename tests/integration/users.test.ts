import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { users } from '../../src/lib/server/db/schema';

const TEST_DATABASE_URL =
	process.env.TEST_DATABASE_URL ?? 'postgres://codex:codex@localhost:5432/codex_test';

// Create the throwaway test database if it is missing, so the suite runs
// against any Postgres the environment provides without extra setup.
async function ensureTestDatabase() {
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

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool);
	await migrate(db, { migrationsFolder: 'drizzle' });
	await pool.query('truncate table users');
});

afterAll(async () => {
	await pool.end();
});

describe('users table', () => {
	it('inserts a user and reads it back with defaults applied', async () => {
		const [inserted] = await db
			.insert(users)
			.values({
				email: 'ada@example.com',
				displayName: 'Ada',
				passwordHash: 'not-a-real-hash',
				role: 'admin'
			})
			.returning();

		expect(inserted.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(inserted.profilePublic).toBe(false);
		expect(inserted.publicArchiveEnabled).toBe(false);
		expect(inserted.llmConfig).toEqual({});
		expect(inserted.preferences).toEqual({});
		expect(inserted.storageUsedBytes).toBe(0);
		expect(inserted.createdAt).toBeInstanceOf(Date);
		expect(inserted.emailVerifiedAt).toBeNull();
		expect(inserted.approvedAt).toBeNull();

		const [found] = await db.select().from(users).where(eq(users.email, 'ada@example.com'));
		expect(found.id).toBe(inserted.id);
		expect(found.displayName).toBe('Ada');
	});

	it('rejects a duplicate email', async () => {
		const error: unknown = await db
			.insert(users)
			.values({
				email: 'ada@example.com',
				displayName: 'Other Ada',
				passwordHash: 'not-a-real-hash',
				role: 'user'
			})
			.then(
				() => null,
				(e: unknown) => e
			);

		// Drizzle wraps the driver error; Postgres signals unique_violation as 23505.
		expect(error).toBeInstanceOf(Error);
		const cause = (error as Error).cause as { code?: string };
		expect(cause.code).toBe('23505');
	});

	it('treats handles as case-insensitive', async () => {
		await db.update(users).set({ handle: 'Ada' }).where(eq(users.email, 'ada@example.com'));

		const [byLower] = await db.select().from(users).where(eq(users.handle, 'ada'));
		expect(byLower?.email).toBe('ada@example.com');
	});
});
