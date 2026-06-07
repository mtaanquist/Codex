import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { authTokens, users } from '../../src/lib/server/db/schema';
import {
	approveUser,
	listAllUsers,
	rejectUser,
	setUserArchive,
	setUserSuspended
} from '../../src/lib/server/admin';
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

	it('waives a still-unconfirmed email, so approval alone allows sign-in', async () => {
		const id = await makeUser('unconfirmed@example.com');
		expect(await approveUser(db, id)).toBe(true);
		const [row] = await db.select().from(users).where(eq(users.id, id));
		expect(row.emailVerifiedAt).not.toBeNull();
	});

	it('leaves an already-confirmed email timestamp alone', async () => {
		const id = await makeUser('confirmed@example.com', { verified: true });
		const [before] = await db.select().from(users).where(eq(users.id, id));
		expect(await approveUser(db, id)).toBe(true);
		const [after] = await db.select().from(users).where(eq(users.id, id));
		expect(after.emailVerifiedAt).toEqual(before.emailVerifiedAt);
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

describe('listAllUsers', () => {
	it('returns every account, newest first', async () => {
		await makeUser('admin@example.com', { role: 'admin', approved: true, verified: true });
		await makeUser('active@example.com', { approved: true });
		await makeUser('pending@example.com');
		const all = await listAllUsers(db);
		expect(all).toHaveLength(3);
		// createdAt descending: the last inserted comes first.
		expect(all[0].email).toBe('pending@example.com');
	});
});

describe('setUserArchive', () => {
	it('enables and disables a user public archive', async () => {
		const id = await makeUser('pub@example.com', { approved: true });
		expect(await setUserArchive(db, id, true)).toBe(true);
		let [row] = await db.select().from(users).where(eq(users.id, id));
		expect(row.publicArchiveEnabled).toBe(true);
		expect(await setUserArchive(db, id, false)).toBe(true);
		[row] = await db.select().from(users).where(eq(users.id, id));
		expect(row.publicArchiveEnabled).toBe(false);
	});
});

describe('setUserSuspended', () => {
	it('suspends and unsuspends a user, but never an admin', async () => {
		const id = await makeUser('naughty@example.com', { approved: true });
		expect(await setUserSuspended(db, id, true)).toBe(true);
		let [row] = await db.select().from(users).where(eq(users.id, id));
		expect(row.suspendedAt).not.toBeNull();
		expect(await setUserSuspended(db, id, false)).toBe(true);
		[row] = await db.select().from(users).where(eq(users.id, id));
		expect(row.suspendedAt).toBeNull();

		const admin = await makeUser('boss@example.com', { role: 'admin', approved: true });
		expect(await setUserSuspended(db, admin, true)).toBe(false);
	});
});
