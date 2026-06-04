import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { authTokens, users } from '../../src/lib/server/db/schema';
import { adminEmails, approveUser, listPendingUsers, rejectUser } from '../../src/lib/server/admin';
import { issueToken } from '../../src/lib/server/tokens';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;

async function makeUser(
	email: string,
	opts: { role?: 'admin' | 'user'; approved?: boolean; verified?: boolean } = {}
) {
	const [row] = await db
		.insert(users)
		.values({
			email,
			displayName: email.split('@')[0],
			passwordHash: 'x',
			role: opts.role ?? 'user',
			emailVerifiedAt: opts.verified ? new Date() : null,
			approvedAt: opts.approved ? new Date() : null
		})
		.returning({ id: users.id });
	return row.id;
}

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

describe('listPendingUsers', () => {
	it('lists unapproved non-admins only, oldest first', async () => {
		await makeUser('admin@example.com', { role: 'admin', approved: true, verified: true });
		await makeUser('approved@example.com', { approved: true });
		await makeUser('pending-a@example.com');
		await makeUser('pending-b@example.com');

		const pending = await listPendingUsers(db);
		expect(pending.map((u) => u.email)).toEqual(['pending-a@example.com', 'pending-b@example.com']);
	});
});

describe('approveUser', () => {
	it('approves a pending account and is a no-op the second time', async () => {
		const id = await makeUser('p@example.com');
		expect(await approveUser(db, id)).toBe(true);
		const [row] = await db.select().from(users).where(eq(users.id, id));
		expect(row.approvedAt).not.toBeNull();
		// Already approved: nothing left to do.
		expect(await approveUser(db, id)).toBe(false);
	});

	it('refuses to approve an admin', async () => {
		const id = await makeUser('a@example.com', { role: 'admin' });
		expect(await approveUser(db, id)).toBe(false);
	});
});

describe('rejectUser', () => {
	it('deletes a pending account and its tokens', async () => {
		const id = await makeUser('r@example.com');
		await issueToken(db, id, 'email_verify', 60);
		expect(await rejectUser(db, id)).toBe(true);
		expect(await db.select().from(users).where(eq(users.id, id))).toHaveLength(0);
		expect(await db.select().from(authTokens).where(eq(authTokens.userId, id))).toHaveLength(0);
	});

	it('refuses to reject an approved account or an admin', async () => {
		const approved = await makeUser('ok@example.com', { approved: true });
		const admin = await makeUser('boss@example.com', { role: 'admin' });
		expect(await rejectUser(db, approved)).toBe(false);
		expect(await rejectUser(db, admin)).toBe(false);
		expect(await db.select().from(users)).toHaveLength(2);
	});
});

describe('adminEmails', () => {
	it('returns every admin address', async () => {
		await makeUser('boss1@example.com', { role: 'admin' });
		await makeUser('boss2@example.com', { role: 'admin' });
		await makeUser('writer@example.com');
		expect((await adminEmails(db)).sort()).toEqual(['boss1@example.com', 'boss2@example.com']);
	});
});
