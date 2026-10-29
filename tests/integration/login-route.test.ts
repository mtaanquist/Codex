import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { isRedirect } from '@sveltejs/kit';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type pg from 'pg';
import { users } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import { hashPassword } from '../../src/lib/server/password';
import { totpCode } from '../../src/lib/server/totp';
import { ensureTestDatabase } from './test-db';

// The password and two-factor sign-in actions, called as the real handlers
// against the test database: the limiter wiring and the order of the
// two-factor step (rate limit, peek challenge, verify, consume).

process.env.APP_SECRET = process.env.APP_SECRET || 'login-route-test-secret';

vi.mock('#lib/server/db', async () => {
	const { default: pgModule } = await import('pg');
	const { drizzle } = await import('drizzle-orm/node-postgres');
	const schemaModule = await import('../../src/lib/server/db/schema');
	const { TEST_DATABASE_URL } = await import('./test-db');
	const testPool = new pgModule.Pool({ connectionString: TEST_DATABASE_URL });
	return { db: drizzle(testPool, { schema: schemaModule }), pool: testPool };
});

const { db, pool } = (await import('#lib/server/db')) as unknown as {
	db: Database;
	pool: pg.Pool;
};
const { resetRateLimits } = await import('#lib/server/rate-limit');
const { beginEnrollment, confirmEnrollment, recoveryCodesRemaining, TOTP_CHALLENGE_COOKIE } =
	await import('../../src/lib/server/two-factor');
const loginPage = await import('../../src/routes/login/+page.server');
const totpPage = await import('../../src/routes/login/totp/+page.server');

const PASSWORD = 'correct horse battery';
const EMAIL = 'tfa-login@example.com';

let userId: string;
let secret: string;
let recoveryCodes: string[];

function cookieJar(initial: Record<string, string> = {}) {
	const store = new Map(Object.entries(initial));
	return {
		store,
		get: (name: string) => store.get(name),
		set: (name: string, value: string) => void store.set(name, value),
		delete: (name: string) => void store.delete(name)
	};
}

function event(fields: Record<string, string>, cookies = cookieJar(), ip = '203.0.113.1') {
	const form = new FormData();
	for (const [key, value] of Object.entries(fields)) form.set(key, value);
	return {
		request: { formData: async () => form, headers: new Headers() },
		cookies,
		getClientAddress: () => ip
	};
}

// Runs an action, turning a thrown redirect into a value so tests can assert
// on where it went.
async function run(action: unknown, ev: unknown): Promise<{ status: number; location?: string }> {
	try {
		const result = (await (action as (e: unknown) => Promise<unknown>)(ev)) as {
			status: number;
		};
		return { status: result.status };
	} catch (err) {
		if (isRedirect(err)) return { status: err.status, location: err.location };
		throw err;
	}
}

// Signs in with the password and returns the jar holding the challenge cookie.
async function passwordStep() {
	const jar = cookieJar();
	const res = await run(
		loginPage.actions.default,
		event({ email: EMAIL, password: PASSWORD }, jar)
	);
	expect(res.location).toBe('/login/totp');
	expect(jar.get(TOTP_CHALLENGE_COOKIE)).toBeTruthy();
	return jar;
}

function submitCode(jar: ReturnType<typeof cookieJar>, code: string, mode = 'code') {
	return run(totpPage.actions.default, event({ code, mode }, jar));
}

beforeAll(async () => {
	await ensureTestDatabase();
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query('truncate table users cascade');
	resetRateLimits();
	const [user] = await db
		.insert(users)
		.values({
			email: EMAIL,
			displayName: 'T',
			passwordHash: await hashPassword(PASSWORD),
			role: 'user',
			emailVerifiedAt: new Date(),
			approvedAt: new Date()
		})
		.returning({ id: users.id });
	userId = user.id;
	const begin = await beginEnrollment(db, userId, EMAIL);
	if (!begin.ok) throw new Error('enrolment refused');
	const confirm = await confirmEnrollment(db, userId, totpCode(begin.secret));
	if (!confirm.ok) throw new Error('confirmation failed');
	secret = begin.secret;
	recoveryCodes = confirm.recoveryCodes;
});

afterAll(async () => {
	await pool.end();
});

describe('password step limits', () => {
	it('refuses the 16th attempt against one email', async () => {
		for (let i = 0; i < 15; i++) {
			const res = await run(
				loginPage.actions.default,
				event({ email: EMAIL, password: 'wrong' }, cookieJar(), `198.51.100.${i}`)
			);
			expect(res.status).toBe(400);
		}
		// The right password from a fresh address is still refused.
		const res = await run(
			loginPage.actions.default,
			event({ email: EMAIL, password: PASSWORD }, cookieJar(), '192.0.2.200')
		);
		expect(res.status).toBe(429);
	});

	it('refuses the 51st attempt from one address across many emails', async () => {
		for (let i = 0; i < 50; i++) {
			const res = await run(
				loginPage.actions.default,
				event({ email: `spray${i}@example.com`, password: 'guess' })
			);
			expect(res.status).toBe(400);
		}
		const res = await run(loginPage.actions.default, event({ email: EMAIL, password: PASSWORD }));
		expect(res.status).toBe(429);
	});
});

describe('two-factor step', () => {
	it('signs in with a valid code and spends the challenge', async () => {
		const jar = await passwordStep();
		const res = await submitCode(jar, totpCode(secret, Date.now() + 30_000));
		expect(res.location).toBe('/');
		expect(jar.get('session')).toBeTruthy();
		expect(jar.get(TOTP_CHALLENGE_COOKIE)).toBeUndefined();
	});

	it('refuses the 11th code attempt for one account, even from fresh addresses', async () => {
		const jar = await passwordStep();
		for (let i = 0; i < 10; i++) {
			const res = await run(
				totpPage.actions.default,
				event({ code: '000000', mode: 'code' }, jar, `198.51.100.${i}`)
			);
			expect(res.status).toBe(400);
		}
		// The right code is refused once the account's budget is spent.
		const res = await run(
			totpPage.actions.default,
			event({ code: totpCode(secret, Date.now() + 30_000), mode: 'code' }, jar, '192.0.2.200')
		);
		expect(res.status).toBe(429);
		expect(jar.get('session')).toBeUndefined();
	});

	it('does not spend a recovery code on a stale challenge', async () => {
		const stale = await passwordStep();
		// A second password step supersedes the first challenge.
		await passwordStep();
		const before = await recoveryCodesRemaining(db, userId);

		const res = await submitCode(stale, recoveryCodes[0], 'recovery');
		expect(res.location).toBe('/login');
		expect(stale.get('session')).toBeUndefined();
		expect(await recoveryCodesRemaining(db, userId)).toBe(before);
	});

	it('spends a recovery code on a live challenge', async () => {
		const jar = await passwordStep();
		const before = await recoveryCodesRemaining(db, userId);
		const res = await submitCode(jar, recoveryCodes[0], 'recovery');
		expect(res.location).toBe('/');
		expect(await recoveryCodesRemaining(db, userId)).toBe(before - 1);
	});
});
