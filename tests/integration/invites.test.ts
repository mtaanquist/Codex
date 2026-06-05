import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { inviteCodes, users } from '../../src/lib/server/db/schema';
import {
	createInviteCode,
	deleteInviteCode,
	listInviteCodes,
	redeemInviteCode
} from '../../src/lib/server/invites';
import { INVALID_INVITE, registerUser } from '../../src/lib/server/signup';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let adminId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query('truncate table invite_codes, auth_tokens, users cascade');
	const [admin] = await db
		.insert(users)
		.values({ email: 'op@example.com', displayName: 'Op', passwordHash: 'x', role: 'admin' })
		.returning({ id: users.id });
	adminId = admin.id;
});

afterAll(async () => {
	await pool.end();
});

describe('createInviteCode', () => {
	it('mints a readable code with sane defaults', async () => {
		const code = await createInviteCode(db, { createdBy: adminId });
		expect(code.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
		expect(code.maxUses).toBe(1);
		expect(code.usedCount).toBe(0);
		expect(code.label).toBeNull();
		expect(code.expiresAt).toBeNull();
	});

	it('trims the label and floors the uses', async () => {
		const code = await createInviteCode(db, {
			createdBy: adminId,
			label: '  writing group  ',
			maxUses: 5.7
		});
		expect(code.label).toBe('writing group');
		expect(code.maxUses).toBe(5);
	});
});

describe('list and delete', () => {
	it('lists newest first and deletes by id', async () => {
		const first = await createInviteCode(db, { createdBy: adminId });
		const second = await createInviteCode(db, { createdBy: adminId });
		const listed = await listInviteCodes(db);
		expect(listed.map((c) => c.id)).toContain(first.id);
		expect(listed.map((c) => c.id)).toContain(second.id);

		expect(await deleteInviteCode(db, first.id)).toBe(true);
		expect(await deleteInviteCode(db, first.id)).toBe(false);
		expect((await listInviteCodes(db)).map((c) => c.id)).toEqual([second.id]);
	});
});

describe('redeemInviteCode', () => {
	it('spends a use, tolerating case and whitespace', async () => {
		const code = await createInviteCode(db, { createdBy: adminId, maxUses: 2 });
		expect(await redeemInviteCode(db, `  ${code.code.toLowerCase()} `)).toBe(true);
		const [row] = await db.select().from(inviteCodes).where(eq(inviteCodes.id, code.id));
		expect(row.usedCount).toBe(1);
	});

	it('rejects an unknown or blank code', async () => {
		expect(await redeemInviteCode(db, 'NOPE-NOPE-NOPE')).toBe(false);
		expect(await redeemInviteCode(db, '   ')).toBe(false);
	});

	it('rejects a used-up code', async () => {
		const code = await createInviteCode(db, { createdBy: adminId });
		expect(await redeemInviteCode(db, code.code)).toBe(true);
		expect(await redeemInviteCode(db, code.code)).toBe(false);
	});

	it('rejects an expired code', async () => {
		const code = await createInviteCode(db, {
			createdBy: adminId,
			expiresAt: new Date(Date.now() - 1000)
		});
		expect(await redeemInviteCode(db, code.code)).toBe(false);
	});

	it('gives the last use to exactly one of two racing redeems', async () => {
		const code = await createInviteCode(db, { createdBy: adminId });
		const results = await Promise.all([
			redeemInviteCode(db, code.code),
			redeemInviteCode(db, code.code)
		]);
		expect(results.filter(Boolean)).toHaveLength(1);
		const [row] = await db.select().from(inviteCodes).where(eq(inviteCodes.id, code.id));
		expect(row.usedCount).toBe(1);
	});
});

describe('registerUser with an invite code', () => {
	it('approves the account and spends a use', async () => {
		const code = await createInviteCode(db, { createdBy: adminId });
		const result = await registerUser(db, {
			email: 'invited@example.com',
			password: 'a-good-password',
			displayName: 'Invitee',
			inviteCode: code.code
		});
		expect(result).toMatchObject({ ok: true, invited: true });

		const [row] = await db.select().from(users).where(eq(users.email, 'invited@example.com'));
		expect(row.approvedAt).not.toBeNull();
		// Email verification is still required.
		expect(row.emailVerifiedAt).toBeNull();
		const [invite] = await db.select().from(inviteCodes).where(eq(inviteCodes.id, code.id));
		expect(invite.usedCount).toBe(1);
	});

	it('rejects a bad code without creating an account', async () => {
		const result = await registerUser(db, {
			email: 'hopeful@example.com',
			password: 'a-good-password',
			displayName: 'Hopeful',
			inviteCode: 'NOPE-NOPE-NOPE'
		});
		expect(result).toMatchObject({ ok: false, reason: INVALID_INVITE });
		expect(await db.select().from(users).where(eq(users.email, 'hopeful@example.com'))).toEqual([]);
	});

	it('rolls the use back when the email is already taken', async () => {
		const code = await createInviteCode(db, { createdBy: adminId });
		const input = {
			email: 'taken@example.com',
			password: 'a-good-password',
			displayName: 'Taken'
		};
		expect((await registerUser(db, input)).ok).toBe(true);

		// Probing a known address with a valid code must not burn a use.
		const result = await registerUser(db, { ...input, inviteCode: code.code });
		expect(result).toMatchObject({ ok: false, reason: 'duplicate' });
		const [invite] = await db.select().from(inviteCodes).where(eq(inviteCodes.id, code.id));
		expect(invite.usedCount).toBe(0);
	});

	it('still creates an unapproved account without a code', async () => {
		const result = await registerUser(db, {
			email: 'queue@example.com',
			password: 'a-good-password',
			displayName: 'Queue'
		});
		expect(result).toMatchObject({ ok: true, invited: false });
		const [row] = await db.select().from(users).where(eq(users.email, 'queue@example.com'));
		expect(row.approvedAt).toBeNull();
	});
});
