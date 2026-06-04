import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, eq, isNull } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { sessions, users } from '../../src/lib/server/db/schema';
import {
	changeDisplayName,
	changePassword,
	confirmEmailChange,
	listSessions,
	requestEmailChange,
	revokeOtherSessions,
	revokeOwnSession
} from '../../src/lib/server/account';
import { hashPassword, verifyPassword } from '../../src/lib/server/password';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let userId: string;

async function newSession() {
	const [row] = await db
		.insert(sessions)
		.values({ userId, expiresAt: new Date(Date.now() + 60_000) })
		.returning({ id: sessions.id });
	return row.id;
}

function liveSessions() {
	return db
		.select()
		.from(sessions)
		.where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query('truncate table sessions, users cascade');
	const [user] = await db
		.insert(users)
		.values({
			email: 'acct@example.com',
			displayName: 'Old Name',
			passwordHash: await hashPassword('current-password'),
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

describe('changeDisplayName', () => {
	it('trims and saves, and rejects empty', async () => {
		expect((await changeDisplayName(db, userId, '  New Name  ')).ok).toBe(true);
		const [row] = await db.select().from(users).where(eq(users.id, userId));
		expect(row.displayName).toBe('New Name');
		expect((await changeDisplayName(db, userId, '   ')).ok).toBe(false);
	});
});

describe('changePassword', () => {
	it('changes the password and revokes other sessions, keeping the current one', async () => {
		const current = await newSession();
		const other = await newSession();

		const result = await changePassword(db, userId, current, 'current-password', 'a-new-password');
		expect(result.ok).toBe(true);

		const [row] = await db.select().from(users).where(eq(users.id, userId));
		expect(await verifyPassword(row.passwordHash, 'a-new-password')).toBe(true);

		const live = (await liveSessions()).map((s) => s.id);
		expect(live).toContain(current);
		expect(live).not.toContain(other);
	});

	it('rejects a wrong current password and a too-short new one', async () => {
		const current = await newSession();
		expect((await changePassword(db, userId, current, 'wrong', 'a-new-password')).ok).toBe(false);
		expect((await changePassword(db, userId, current, 'current-password', 'short')).ok).toBe(false);
		// Unchanged.
		const [row] = await db.select().from(users).where(eq(users.id, userId));
		expect(await verifyPassword(row.passwordHash, 'current-password')).toBe(true);
	});
});

describe('email change', () => {
	it('records a pending address and swaps it in on confirmation', async () => {
		const result = await requestEmailChange(db, userId, 'current-password', '  New@Example.com ');
		expect(result.ok).toBe(true);
		let [row] = await db.select().from(users).where(eq(users.id, userId));
		// The live email is unchanged until confirmation.
		expect(row.email).toBe('acct@example.com');
		expect(row.pendingEmail).toBe('new@example.com');

		if (!result.ok) throw new Error('unreachable');
		expect((await confirmEmailChange(db, result.token)).ok).toBe(true);
		[row] = await db.select().from(users).where(eq(users.id, userId));
		expect(row.email).toBe('new@example.com');
		expect(row.pendingEmail).toBeNull();
		expect(row.emailVerifiedAt).not.toBeNull();
	});

	it('rejects a wrong password, an invalid address, and a taken one', async () => {
		await db.insert(users).values({
			email: 'taken@example.com',
			displayName: 'T',
			passwordHash: 'x',
			role: 'user'
		});
		expect((await requestEmailChange(db, userId, 'wrong', 'fine@example.com')).ok).toBe(false);
		expect((await requestEmailChange(db, userId, 'current-password', 'nope')).ok).toBe(false);
		expect((await requestEmailChange(db, userId, 'current-password', 'taken@example.com')).ok).toBe(
			false
		);
		const [row] = await db.select().from(users).where(eq(users.id, userId));
		expect(row.pendingEmail).toBeNull();
	});

	it('refuses an unknown confirmation token', async () => {
		expect((await confirmEmailChange(db, 'not-a-real-token')).ok).toBe(false);
	});
});

describe('sessions', () => {
	it('lists live sessions with the current one flagged', async () => {
		const current = await newSession();
		await newSession();
		const list = await listSessions(db, userId, current);
		expect(list).toHaveLength(2);
		expect(list.find((s) => s.current)?.id).toBe(current);
	});

	it('revokes one of the user own sessions only', async () => {
		const a = await newSession();
		expect(await revokeOwnSession(db, userId, a)).toBe(true);
		expect(await revokeOwnSession(db, userId, a)).toBe(false); // already revoked
		expect(await revokeOwnSession(db, userId, '00000000-0000-0000-0000-000000000000')).toBe(false);
	});

	it('signs out everywhere else', async () => {
		const current = await newSession();
		await newSession();
		await newSession();
		await revokeOtherSessions(db, userId, current);
		const live = (await liveSessions()).map((s) => s.id);
		expect(live).toEqual([current]);
	});
});
