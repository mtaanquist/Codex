import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { users } from '../../src/lib/server/db/schema';
import { createFirstAdmin } from '../../src/lib/server/admin';
import { verifyPassword } from '../../src/lib/server/password';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query('truncate table users cascade');
});

afterAll(async () => {
	await pool.end();
});

describe('createFirstAdmin', () => {
	it('creates a pre-verified, pre-approved admin and normalises the email', async () => {
		const result = await createFirstAdmin(db, {
			email: '  Admin@Example.com  ',
			password: 'correct horse battery staple',
			displayName: 'Site Admin'
		});
		expect(result.ok).toBe(true);

		const [row] = await db.select().from(users).where(eq(users.role, 'admin'));
		expect(row.email).toBe('admin@example.com');
		expect(row.displayName).toBe('Site Admin');
		expect(row.emailVerifiedAt).not.toBeNull();
		expect(row.approvedAt).not.toBeNull();
		expect(await verifyPassword(row.passwordHash, 'correct horse battery staple')).toBe(true);
	});

	it('refuses once an admin already exists', async () => {
		await createFirstAdmin(db, { email: 'a@example.com', password: 'pw1', displayName: 'A' });
		const second = await createFirstAdmin(db, {
			email: 'b@example.com',
			password: 'pw2',
			displayName: 'B'
		});
		expect(second.ok).toBe(false);
		expect(await db.select().from(users)).toHaveLength(1);
	});

	it('reports a taken email rather than throwing', async () => {
		// A plain user already holds the address; no admin exists yet, so the
		// bootstrap guard passes and the insert hits the unique constraint.
		await db.insert(users).values({
			email: 'taken@example.com',
			displayName: 'U',
			passwordHash: 'x',
			role: 'user'
		});
		const result = await createFirstAdmin(db, {
			email: 'taken@example.com',
			password: 'pw',
			displayName: 'Dup'
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(/email/i);
	});

	it('rejects missing fields', async () => {
		const result = await createFirstAdmin(db, { email: '', password: 'pw', displayName: 'X' });
		expect(result.ok).toBe(false);
		expect(await db.select().from(users)).toHaveLength(0);
	});
});
