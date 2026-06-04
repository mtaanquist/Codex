import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { authTokens, users } from '../../src/lib/server/db/schema';
import { registerUser, verifyEmail } from '../../src/lib/server/signup';
import { consumeToken, issueToken } from '../../src/lib/server/tokens';
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
	await pool.query('truncate table auth_tokens, users cascade');
});

afterAll(async () => {
	await pool.end();
});

describe('registerUser', () => {
	it('creates an unverified, unapproved user with a normalised email', async () => {
		const result = await registerUser(db, {
			email: '  New@Example.com ',
			password: 'a-good-password',
			displayName: '  Nora  '
		});
		expect(result.ok).toBe(true);

		const [row] = await db.select().from(users).where(eq(users.email, 'new@example.com'));
		expect(row.displayName).toBe('Nora');
		expect(row.role).toBe('user');
		expect(row.emailVerifiedAt).toBeNull();
		expect(row.approvedAt).toBeNull();
	});

	it('rejects a bad email, a short password, and an empty name', async () => {
		expect(
			(await registerUser(db, { email: 'nope', password: 'a-good-password', displayName: 'X' })).ok
		).toBe(false);
		expect(
			(await registerUser(db, { email: 'a@b.co', password: 'short', displayName: 'X' })).ok
		).toBe(false);
		expect(
			(await registerUser(db, { email: 'a@b.co', password: 'a-good-password', displayName: ' ' }))
				.ok
		).toBe(false);
		expect(await db.select().from(users)).toHaveLength(0);
	});

	it('reports a duplicate without creating a second account', async () => {
		await registerUser(db, {
			email: 'dup@example.com',
			password: 'a-good-password',
			displayName: 'A'
		});
		const second = await registerUser(db, {
			email: 'dup@example.com',
			password: 'another-password',
			displayName: 'B'
		});
		expect(second).toEqual({ ok: false, reason: 'duplicate' });
		expect(await db.select().from(users)).toHaveLength(1);
	});
});

describe('verifyEmail', () => {
	it('confirms the account for a valid token and refuses a reused one', async () => {
		const { userId } = (await registerUser(db, {
			email: 'v@example.com',
			password: 'a-good-password',
			displayName: 'V'
		})) as { ok: true; userId: string };
		const token = await issueToken(db, userId, 'email_verify', 60);

		expect(await verifyEmail(db, token)).toBe(true);
		const [row] = await db.select().from(users).where(eq(users.id, userId));
		expect(row.emailVerifiedAt).not.toBeNull();

		// The token is single-use.
		expect(await verifyEmail(db, token)).toBe(false);
	});

	it('refuses an unknown or expired token', async () => {
		expect(await verifyEmail(db, 'not-a-real-token')).toBe(false);

		const { userId } = (await registerUser(db, {
			email: 'e@example.com',
			password: 'a-good-password',
			displayName: 'E'
		})) as { ok: true; userId: string };
		const token = await issueToken(db, userId, 'email_verify', 60);
		// Backdate the expiry.
		await db
			.update(authTokens)
			.set({ expiresAt: sql`now() - interval '1 minute'` })
			.where(eq(authTokens.userId, userId));
		expect(await verifyEmail(db, token)).toBe(false);
	});
});

describe('consumeToken', () => {
	it('does not cross token kinds', async () => {
		const { userId } = (await registerUser(db, {
			email: 'k@example.com',
			password: 'a-good-password',
			displayName: 'K'
		})) as { ok: true; userId: string };
		const token = await issueToken(db, userId, 'password_reset', 60);
		// A password_reset token must not pass as an email_verify token.
		expect(await consumeToken(db, 'email_verify', token)).toBeNull();
		expect(await consumeToken(db, 'password_reset', token)).toBe(userId);
	});
});
