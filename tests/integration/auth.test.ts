import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { users, sessions } from '../../src/lib/server/db/schema';
import {
	createSession,
	revokeSession,
	validateSession,
	verifyCredentials,
	type Database
} from '../../src/lib/server/auth';
import { hashPassword } from '../../src/lib/server/password';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;

async function seedUser(
	email: string,
	overrides: Partial<typeof users.$inferInsert> = {}
): Promise<string> {
	const [user] = await db
		.insert(users)
		.values({
			email,
			displayName: 'Test User',
			passwordHash: await hashPassword('correct horse'),
			role: 'user',
			emailVerifiedAt: new Date(),
			approvedAt: new Date(),
			...overrides
		})
		.returning();
	return user.id;
}

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
	await pool.query('truncate table sessions, auth_tokens, users cascade');
});

afterAll(async () => {
	await pool.end();
});

describe('verifyCredentials', () => {
	it('accepts a verified, approved user with the right password', async () => {
		await seedUser('ok@example.com');
		const result = await verifyCredentials(db, 'ok@example.com', 'correct horse');
		expect(result.status).toBe('ok');
		if (result.status === 'ok') {
			expect(result.user.email).toBe('ok@example.com');
			expect(result.user).not.toHaveProperty('passwordHash');
		}
	});

	it('rejects a wrong password and an unknown email the same way', async () => {
		expect((await verifyCredentials(db, 'ok@example.com', 'wrong')).status).toBe('invalid');
		expect((await verifyCredentials(db, 'nobody@example.com', 'wrong')).status).toBe('invalid');
	});

	it('blocks an unverified email even with the right password', async () => {
		await seedUser('unverified@example.com', { emailVerifiedAt: null });
		const result = await verifyCredentials(db, 'unverified@example.com', 'correct horse');
		expect(result.status).toBe('unverified');
	});

	it('blocks an unapproved account even with the right password', async () => {
		await seedUser('unapproved@example.com', { approvedAt: null });
		const result = await verifyCredentials(db, 'unapproved@example.com', 'correct horse');
		expect(result.status).toBe('unapproved');
	});

	it('blocks a suspended account even with the right password', async () => {
		await seedUser('suspended@example.com', { suspendedAt: new Date() });
		const result = await verifyCredentials(db, 'suspended@example.com', 'correct horse');
		expect(result.status).toBe('suspended');
	});

	it('blocks an account with a pending deletion the same way', async () => {
		await seedUser('leaving@example.com', { deletionScheduledAt: new Date() });
		const result = await verifyCredentials(db, 'leaving@example.com', 'correct horse');
		expect(result.status).toBe('suspended');
	});
});

describe('sessions', () => {
	it('creates a session that validates and stamps last_login_at', async () => {
		const userId = await seedUser('sessions@example.com');
		const session = await createSession(db, userId, { userAgent: 'test', ip: '127.0.0.1' });

		// The cookie carries the raw token, not the row id; validation is by token.
		const result = await validateSession(db, session.token);
		expect(result?.user.id).toBe(userId);
		expect(result?.session.id).toBe(session.id);
		// The id is not the bearer token: presenting it must not validate.
		expect(await validateSession(db, session.id)).toBeNull();

		const [user] = await db.select().from(users).where(eq(users.id, userId));
		expect(user.lastLoginAt).not.toBeNull();
	});

	it('rejects a revoked session', async () => {
		const userId = await seedUser('revoked@example.com');
		const session = await createSession(db, userId);
		await revokeSession(db, session.id);
		expect(await validateSession(db, session.token)).toBeNull();
	});

	it('rejects an expired session', async () => {
		const userId = await seedUser('expired@example.com');
		const session = await createSession(db, userId);
		await db
			.update(sessions)
			.set({ expiresAt: sql`now() - interval '1 minute'` })
			.where(eq(sessions.id, session.id));
		expect(await validateSession(db, session.token)).toBeNull();
	});

	it('rejects a token that matches no session', async () => {
		expect(await validateSession(db, crypto.randomUUID())).toBeNull();
	});

	it('rejects a stale or malformed cookie without throwing', async () => {
		// Any cookie value is hashed and compared; a garbage or empty value simply
		// matches no row and reads as no session, so the hook can clear it.
		expect(await validateSession(db, 'not-a-token')).toBeNull();
		expect(await validateSession(db, '')).toBeNull();
	});

	it('drops a live session when the account is suspended', async () => {
		const userId = await seedUser('suspend-session@example.com');
		const session = await createSession(db, userId);
		expect(await validateSession(db, session.token)).not.toBeNull();
		await db.update(users).set({ suspendedAt: new Date() }).where(eq(users.id, userId));
		expect(await validateSession(db, session.token)).toBeNull();
	});
});
