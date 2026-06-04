import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, eq, isNull } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { sessions, users } from '../../src/lib/server/db/schema';
import { requestPasswordReset, resetPassword } from '../../src/lib/server/password-reset';
import { verifyPassword } from '../../src/lib/server/password';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let userId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query('truncate table sessions, auth_tokens, users cascade');
	const [user] = await db
		.insert(users)
		.values({
			email: 'reset@example.com',
			displayName: 'Reset',
			passwordHash: 'old-hash',
			role: 'user',
			emailVerifiedAt: new Date(),
			approvedAt: new Date()
		})
		.returning({ id: users.id });
	userId = user.id;
});

afterAll(async () => {
	await pool.end();
});

describe('requestPasswordReset', () => {
	it('returns a token for a known address, regardless of case or padding', async () => {
		const token = await requestPasswordReset(db, '  Reset@Example.com ');
		expect(token).toBeTruthy();
	});

	it('returns null for an unknown address without leaking', async () => {
		expect(await requestPasswordReset(db, 'nobody@example.com')).toBeNull();
	});
});

describe('resetPassword', () => {
	it('sets the new password and revokes existing sessions', async () => {
		await db.insert(sessions).values({ userId, expiresAt: new Date(Date.now() + 60_000) });
		const token = (await requestPasswordReset(db, 'reset@example.com')) as string;

		const result = await resetPassword(db, token, 'brand-new-password');
		expect(result.ok).toBe(true);

		const [user] = await db.select().from(users).where(eq(users.id, userId));
		expect(await verifyPassword(user.passwordHash, 'brand-new-password')).toBe(true);

		const live = await db
			.select()
			.from(sessions)
			.where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
		expect(live).toHaveLength(0);
	});

	it('refuses a too-short password without consuming the token', async () => {
		const token = (await requestPasswordReset(db, 'reset@example.com')) as string;
		expect((await resetPassword(db, token, 'short')).ok).toBe(false);
		// The link still works for a valid attempt afterwards.
		expect((await resetPassword(db, token, 'a-good-password')).ok).toBe(true);
	});

	it('refuses an unknown token and a reused one', async () => {
		expect((await resetPassword(db, 'not-real', 'a-good-password')).ok).toBe(false);
		const token = (await requestPasswordReset(db, 'reset@example.com')) as string;
		expect((await resetPassword(db, token, 'a-good-password')).ok).toBe(true);
		expect((await resetPassword(db, token, 'another-password')).ok).toBe(false);
	});
});
