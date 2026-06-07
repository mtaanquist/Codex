import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, eq, isNull } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { sessions, users } from '../../src/lib/server/db/schema';
import { createFirstAdmin, instanceStats, setUserSuspended } from '../../src/lib/server/admin';
import { universes, stories } from '../../src/lib/server/db/schema';
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

describe('instanceStats', () => {
	async function makeUser(email: string, over: Partial<typeof users.$inferInsert> = {}) {
		const [row] = await db
			.insert(users)
			.values({ email, displayName: email, passwordHash: 'x', role: 'user', ...over })
			.returning({ id: users.id });
		return row.id;
	}

	it('counts active writers, pending accounts, universes and stories', async () => {
		const now = new Date();
		// active writer
		const ownerId = await makeUser('writer@example.com', { approvedAt: now });
		// pending (not approved)
		await makeUser('pending@example.com');
		// suspended writers are not counted as active
		await makeUser('suspended@example.com', { approvedAt: now, suspendedAt: now });
		// an admin is approved, so it counts as an active writer but never as pending
		await createFirstAdmin(db, {
			email: 'admin@example.com',
			password: 'pw',
			displayName: 'Admin'
		});

		const [universe] = await db
			.insert(universes)
			.values({ ownerId, name: 'U' })
			.returning({ id: universes.id });
		await db.insert(stories).values({ universeId: universe.id, ownerId, title: 'S1' });
		await db.insert(stories).values({ universeId: universe.id, ownerId, title: 'S2' });

		const stats = await instanceStats(db);
		expect(stats.writers).toBe(2); // approved writer + admin, not the suspended or pending one
		expect(stats.pending).toBe(1); // the pending writer; the admin is excluded
		expect(stats.universes).toBe(1);
		expect(stats.stories).toBe(2);
	});

	it('reports zeroes on an empty instance', async () => {
		const stats = await instanceStats(db);
		expect(stats).toEqual({ writers: 0, pending: 0, universes: 0, stories: 0 });
	});
});

describe('setUserSuspended', () => {
	async function liveSessions(userId: string) {
		return await db
			.select({ id: sessions.id })
			.from(sessions)
			.where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
	}

	it('suspends, revokes live sessions, and unsuspending does not revive them', async () => {
		const [user] = await db
			.insert(users)
			.values({ email: 'sub@example.com', displayName: 'Sub', passwordHash: 'x', role: 'user' })
			.returning({ id: users.id });
		await db
			.insert(sessions)
			.values({ userId: user.id, expiresAt: new Date(Date.now() + 3_600_000) });

		expect(await setUserSuspended(db, user.id, true)).toBe(true);
		const [row] = await db.select().from(users).where(eq(users.id, user.id));
		expect(row.suspendedAt).not.toBeNull();
		expect(await liveSessions(user.id)).toHaveLength(0);

		// Unsuspending clears the flag but the revoked session stays dead.
		expect(await setUserSuspended(db, user.id, false)).toBe(true);
		const [after] = await db.select().from(users).where(eq(users.id, user.id));
		expect(after.suspendedAt).toBeNull();
		expect(await liveSessions(user.id)).toHaveLength(0);
	});

	it('refuses to suspend an admin', async () => {
		const [admin] = await db
			.insert(users)
			.values({ email: 'adm@example.com', displayName: 'A', passwordHash: 'x', role: 'admin' })
			.returning({ id: users.id });
		expect(await setUserSuspended(db, admin.id, true)).toBe(false);
	});
});
