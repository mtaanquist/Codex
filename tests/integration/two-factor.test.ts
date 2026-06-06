import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { users } from '../../src/lib/server/db/schema';
import {
	beginEnrollment,
	confirmEnrollment,
	consumeRecoveryCode,
	disableTotp,
	isTotpEnabled,
	issueTotpChallenge,
	readTotpChallenge,
	recoveryCodesRemaining,
	regenerateRecoveryCodes,
	totpStatus,
	verifyUserTotp,
	cancelPendingEnrollment
} from '../../src/lib/server/two-factor';
import { signToken } from '../../src/lib/server/crypto';
import { totpCode } from '../../src/lib/server/totp';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

// crypto.ts derives its key from APP_SECRET; the secret value itself is
// irrelevant to the tests, only that it is set.
process.env.APP_SECRET = process.env.APP_SECRET || 'two-factor-test-secret';

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
	await pool.query('truncate table totp_recovery_codes, user_totp, users cascade');
	const [user] = await db
		.insert(users)
		.values({ email: 'tfa@example.com', displayName: 'T', passwordHash: 'x', role: 'user' })
		.returning({ id: users.id });
	userId = user.id;
});

afterAll(async () => {
	await pool.end();
});

async function enroll() {
	const begin = await beginEnrollment(db, userId, 'tfa@example.com');
	if (!begin.ok) throw new Error('enrolment refused');
	const confirm = await confirmEnrollment(db, userId, totpCode(begin.secret));
	if (!confirm.ok) throw new Error('confirmation failed');
	return { secret: begin.secret, recoveryCodes: confirm.recoveryCodes };
}

describe('enrolment', () => {
	it('moves off -> pending -> on and issues recovery codes', async () => {
		expect((await totpStatus(db, userId)).status).toBe('off');

		const begin = await beginEnrollment(db, userId, 'tfa@example.com');
		expect(begin.ok).toBe(true);
		if (!begin.ok) return;
		expect(begin.otpauthUri).toContain('otpauth://totp/');
		expect((await totpStatus(db, userId)).status).toBe('pending');
		expect(await isTotpEnabled(db, userId)).toBe(false);

		expect((await confirmEnrollment(db, userId, '000000')).ok).toBe(false);

		const confirm = await confirmEnrollment(db, userId, totpCode(begin.secret));
		expect(confirm.ok).toBe(true);
		if (!confirm.ok) return;
		expect(confirm.recoveryCodes).toHaveLength(10);
		expect((await totpStatus(db, userId)).status).toBe('on');
		expect(await isTotpEnabled(db, userId)).toBe(true);
		expect(await recoveryCodesRemaining(db, userId)).toBe(10);
	});

	it('refuses to restart enrolment once two-factor is on', async () => {
		await enroll();
		expect(await beginEnrollment(db, userId, 'tfa@example.com')).toMatchObject({ ok: false });
	});

	it('confirming again does not rotate the recovery codes', async () => {
		const { secret, recoveryCodes } = await enroll();
		// A double-submit of confirm must not delete the codes the user just saw.
		const again = await confirmEnrollment(db, userId, totpCode(secret));
		expect(again.ok).toBe(false);
		expect(await consumeRecoveryCode(db, userId, recoveryCodes[0])).toBe(true);
	});
});

describe('verification', () => {
	it('accepts a fresh code and rejects a wrong one', async () => {
		const { secret } = await enroll();
		// The code that confirmed enrolment is spent; sign in with the next step.
		const next = totpCode(secret, Date.now() + 30_000);
		expect(await verifyUserTotp(db, userId, next)).toBe(true);
		expect(await verifyUserTotp(db, userId, '000000')).toBe(false);
	});

	it('rejects a replayed code within the drift window (single use)', async () => {
		const { secret } = await enroll();
		const code = totpCode(secret, Date.now() + 30_000);
		expect(await verifyUserTotp(db, userId, code)).toBe(true);
		// Same code again, still inside its validity window: a replay, refused.
		expect(await verifyUserTotp(db, userId, code)).toBe(false);
	});
});

describe('recovery codes', () => {
	it('spends a code once and rejects reuse or garbage', async () => {
		const { recoveryCodes } = await enroll();
		const [first] = recoveryCodes;
		expect(await consumeRecoveryCode(db, userId, first)).toBe(true);
		expect(await consumeRecoveryCode(db, userId, first)).toBe(false);
		expect(await consumeRecoveryCode(db, userId, 'NOTACODE')).toBe(false);
		expect(await recoveryCodesRemaining(db, userId)).toBe(9);
	});

	it('regenerating invalidates the old codes', async () => {
		const { recoveryCodes } = await enroll();
		const fresh = await regenerateRecoveryCodes(db, userId);
		expect(fresh).toHaveLength(10);
		expect(await consumeRecoveryCode(db, userId, recoveryCodes[0])).toBe(false);
		expect(await consumeRecoveryCode(db, userId, fresh![0])).toBe(true);
	});
});

describe('disable', () => {
	it('removes the secret and the recovery codes', async () => {
		await enroll();
		await disableTotp(db, userId);
		expect((await totpStatus(db, userId)).status).toBe('off');
		expect(await recoveryCodesRemaining(db, userId)).toBe(0);
	});
});

describe('challenge token', () => {
	it('round-trips a fresh token and rejects tampered or expired ones', () => {
		const token = issueTotpChallenge(userId);
		expect(readTotpChallenge(token)).toBe(userId);
		expect(readTotpChallenge(token + 'x')).toBeNull();
		expect(readTotpChallenge(undefined)).toBeNull();
		// A token whose expiry is already in the past, but correctly signed.
		const expired = signToken(`${userId}.${Date.now() - 1000}`);
		expect(readTotpChallenge(expired)).toBeNull();
	});
});

describe('cancelPendingEnrollment', () => {
	it('clears a pending setup but can never strip confirmed two-factor', async () => {
		const begin = await beginEnrollment(db, userId, 'tfa@example.com');
		expect(begin.ok).toBe(true);
		expect(await cancelPendingEnrollment(db, userId)).toBe(true);
		expect((await totpStatus(db, userId)).status).toBe('off');

		// Once confirmed, the cancel path is a no-op; only the password-gated
		// disable removes live two-factor (regression: it used to call
		// disableTotp and wipe a confirmed enrolment).
		const { recoveryCodes } = await enroll();
		expect(await cancelPendingEnrollment(db, userId)).toBe(false);
		expect((await totpStatus(db, userId)).status).toBe('on');
		expect(await recoveryCodesRemaining(db, userId)).toBe(recoveryCodes.length);
	});
});
