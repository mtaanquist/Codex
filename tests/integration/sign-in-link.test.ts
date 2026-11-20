import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { isRedirect } from '@sveltejs/kit';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import type pg from 'pg';
import { authTokens, sessions, users } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import { hashPassword } from '../../src/lib/server/password';
import { setUserSuspended } from '../../src/lib/server/admin';
import { totpCode } from '../../src/lib/server/totp';
import { ensureTestDatabase } from './test-db';
import { sentToken } from './token-helpers';

// Signing in with an emailed link: which accounts get one, what spends it, and
// the page's two actions called as the real handlers against the test database.

process.env.APP_SECRET = process.env.APP_SECRET || 'sign-in-link-test-secret';

vi.mock('#lib/server/db', async () => {
	const { default: pgModule } = await import('pg');
	const { drizzle } = await import('drizzle-orm/node-postgres');
	const schemaModule = await import('../../src/lib/server/db/schema');
	const { TEST_DATABASE_URL } = await import('./test-db');
	const testPool = new pgModule.Pool({ connectionString: TEST_DATABASE_URL });
	return { db: drizzle(testPool, { schema: schemaModule }), pool: testPool };
});
vi.mock('#lib/server/jobs', () => ({ queueEmail: vi.fn(async () => undefined) }));

const { db, pool } = (await import('#lib/server/db')) as unknown as {
	db: Database;
	pool: pg.Pool;
};
const { resetRateLimits } = await import('#lib/server/rate-limit');
const { queueEmail } = await import('#lib/server/jobs');
const { requestSignInLink, redeemSignInLink } = await import('../../src/lib/server/sign-in-link');
const { changePassword, confirmEmailChange, requestEmailChange, revokeOtherSessions } =
	await import('../../src/lib/server/account');
const { requestPasswordReset, resetPassword } = await import('../../src/lib/server/password-reset');
const { beginEnrollment, confirmEnrollment, TOTP_CHALLENGE_COOKIE } =
	await import('../../src/lib/server/two-factor');
const linkPage = await import('../../src/routes/login/link/+page.server');

const EMAIL = 'link@example.com';
const PASSWORD = 'correct horse battery';
let userId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query('truncate table users cascade');
	resetRateLimits();
	vi.mocked(queueEmail).mockClear();
	const [user] = await db
		.insert(users)
		.values({
			email: EMAIL,
			displayName: 'Link',
			passwordHash: await hashPassword(PASSWORD),
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

// Requests a link and arms its token the way the email worker does, returning
// the raw value the emailed link would carry.
async function sentLink(): Promise<string> {
	const tokenId = await requestSignInLink(db, EMAIL);
	return sentToken(db, tokenId!);
}

describe('requestSignInLink', () => {
	it('reserves a token for a known address, regardless of case or padding', async () => {
		expect(await requestSignInLink(db, '  LINK@Example.com ')).toBeTruthy();
	});

	it('sends nothing to an unknown address', async () => {
		expect(await requestSignInLink(db, 'nobody@example.com')).toBeNull();
	});

	it('sends nothing to an account that could not sign in with its password', async () => {
		const blocked = [
			{ emailVerifiedAt: null },
			{ approvedAt: null },
			{ suspendedAt: new Date() },
			{ deletionScheduledAt: new Date() }
		];
		for (const gate of blocked) {
			await db
				.update(users)
				.set({
					emailVerifiedAt: new Date(),
					approvedAt: new Date(),
					suspendedAt: null,
					deletionScheduledAt: null,
					...gate
				})
				.where(eq(users.id, userId));
			expect(await requestSignInLink(db, EMAIL), JSON.stringify(gate)).toBeNull();
		}
		expect(await db.select().from(authTokens)).toHaveLength(0);
	});

	it('revokes an earlier link when a new one is requested', async () => {
		const first = await sentLink();
		const second = await sentLink();
		expect(await redeemSignInLink(db, first)).toBeNull();
		expect(await redeemSignInLink(db, second)).toBe(userId);
	});
});

describe('redeemSignInLink', () => {
	it('works once', async () => {
		const link = await sentLink();
		expect(await redeemSignInLink(db, link)).toBe(userId);
		expect(await redeemSignInLink(db, link)).toBeNull();
	});

	it('refuses an unknown link and an expired one', async () => {
		expect(await redeemSignInLink(db, 'not-a-real-token')).toBeNull();
		const link = await sentLink();
		await db.update(authTokens).set({ expiresAt: sql`now() - interval '1 second'` });
		expect(await redeemSignInLink(db, link)).toBeNull();
	});

	it('refuses a link for an account suspended after it was sent', async () => {
		const link = await sentLink();
		await db.update(users).set({ suspendedAt: new Date() }).where(eq(users.id, userId));
		expect(await redeemSignInLink(db, link)).toBeNull();
	});

	it('stays refused when the account is suspended and let back in', async () => {
		const link = await sentLink();
		expect(await setUserSuspended(db, userId, true)).toBe(true);
		expect(await setUserSuspended(db, userId, false)).toBe(true);
		expect(await redeemSignInLink(db, link)).toBeNull();
	});

	it('is not a link of another kind', async () => {
		const reset = await sentToken(db, (await requestPasswordReset(db, EMAIL))!);
		expect(await redeemSignInLink(db, reset)).toBeNull();
	});
});

describe('a sign-in link dies when the account changes hands', () => {
	it('on a password change', async () => {
		const link = await sentLink();
		const [session] = await db
			.insert(sessions)
			.values({ userId, tokenHash: 'h', expiresAt: new Date(Date.now() + 60_000) })
			.returning({ id: sessions.id });
		expect((await changePassword(db, userId, session.id, PASSWORD, 'a new password')).ok).toBe(
			true
		);
		expect(await redeemSignInLink(db, link)).toBeNull();
	});

	it('on signing out everywhere else', async () => {
		const link = await sentLink();
		const [session] = await db
			.insert(sessions)
			.values({ userId, tokenHash: 'h', expiresAt: new Date(Date.now() + 60_000) })
			.returning({ id: sessions.id });
		await revokeOtherSessions(db, userId, session.id);
		expect(await redeemSignInLink(db, link)).toBeNull();
	});

	it('on a password reset', async () => {
		const link = await sentLink();
		const reset = await sentToken(db, (await requestPasswordReset(db, EMAIL))!);
		expect((await resetPassword(db, reset, 'a new password')).ok).toBe(true);
		expect(await redeemSignInLink(db, link)).toBeNull();
	});

	it('on an email change, along with a reset link sent to the old address', async () => {
		const link = await sentLink();
		const reset = await sentToken(db, (await requestPasswordReset(db, EMAIL))!);
		const change = await requestEmailChange(db, userId, PASSWORD, 'moved@example.com');
		if (!change.ok) throw new Error(change.reason);
		expect((await confirmEmailChange(db, await sentToken(db, change.tokenId))).ok).toBe(true);
		expect(await redeemSignInLink(db, link)).toBeNull();
		expect((await resetPassword(db, reset, 'a new password')).ok).toBe(false);
	});
});

function cookieJar() {
	const store = new Map<string, string>();
	return {
		get: (name: string) => store.get(name),
		set: (name: string, value: string) => void store.set(name, value),
		delete: (name: string) => void store.delete(name)
	};
}

function event(path: string, fields: Record<string, string>, ip = '203.0.113.1') {
	const url = new URL(`http://localhost${path}`);
	const form = new FormData();
	for (const [key, value] of Object.entries(fields)) form.set(key, value);
	return {
		url,
		request: new Request(url, { method: 'POST', body: form }),
		cookies: cookieJar(),
		getClientAddress: () => ip
	};
}

// Runs an action, turning a thrown redirect into a value.
async function run(action: unknown, ev: unknown) {
	try {
		return (await (action as (e: unknown) => Promise<unknown>)(ev)) as {
			status?: number;
			sent?: boolean;
			location?: undefined;
		};
	} catch (err) {
		if (isRedirect(err)) return { status: err.status, location: err.location };
		throw err;
	}
}

const send = (email: string, ip?: string) =>
	run(linkPage.actions.send, event('/login/link', { email }, ip));

describe('the page that asks for a link', () => {
	it('answers the same for a known and an unknown address, mailing only the first', async () => {
		expect(await send(EMAIL)).toEqual({ sent: true });
		expect(queueEmail).toHaveBeenCalledTimes(1);
		expect(vi.mocked(queueEmail).mock.calls[0][0]).toMatchObject({
			to: EMAIL,
			origin: 'http://localhost'
		});
		expect(await send('nobody@example.com')).toEqual({ sent: true });
		expect(queueEmail).toHaveBeenCalledTimes(1);
	});

	it('stops mailing one address after 5 requests, from any address', async () => {
		for (let i = 0; i < 5; i++) await send(EMAIL, `198.51.100.${i}`);
		expect(queueEmail).toHaveBeenCalledTimes(5);
		expect(await send(EMAIL, '192.0.2.200')).toEqual({ sent: true });
		expect(queueEmail).toHaveBeenCalledTimes(5);
	});

	it('stops one client address after 20 requests across many emails', async () => {
		for (let i = 0; i < 20; i++) await send(`nobody${i}@example.com`);
		await send(EMAIL);
		expect(queueEmail).not.toHaveBeenCalled();
	});

	it('shows the button for a live link without spending it, and says when one is dead', async () => {
		const link = await sentLink();
		const load = (token: string) =>
			(
				linkPage.load as (
					e: unknown
				) => Promise<{ token: string; email: string; message: string | null }>
			)({
				url: new URL(`http://localhost/login/link?token=${token}`)
			});
		// The page names the account the button signs in to.
		expect(await load(link)).toMatchObject({ token: link, email: EMAIL, message: null });
		expect(await load(link)).toMatchObject({ token: link, email: EMAIL, message: null });
		const dead = await load('not-a-real-token');
		expect(dead).toMatchObject({ token: '', email: '' });
		expect(dead.message).toContain('not valid');
		expect(await redeemSignInLink(db, link)).toBe(userId);
	});
});

describe('using a link', () => {
	it('signs in and cannot be used again', async () => {
		const link = await sentLink();
		const ev = event('/login/link', { token: link });
		expect(await run(linkPage.actions.use, ev)).toEqual({ status: 303, location: '/' });
		expect(ev.cookies.get('session')).toBeTruthy();
		expect(await db.select().from(sessions)).toHaveLength(1);

		const again = event('/login/link', { token: link });
		expect((await run(linkPage.actions.use, again)).status).toBe(400);
		expect(again.cookies.get('session')).toBeUndefined();
	});

	it('refuses a missing or made-up link', async () => {
		expect((await run(linkPage.actions.use, event('/login/link', {}))).status).toBe(400);
		expect(
			(await run(linkPage.actions.use, event('/login/link', { token: 'made-up' }))).status
		).toBe(400);
		expect(await db.select().from(sessions)).toHaveLength(0);
	});

	it('still asks for the two-factor code when the account has it on', async () => {
		const begin = await beginEnrollment(db, userId, EMAIL);
		if (!begin.ok) throw new Error('enrolment refused');
		const confirm = await confirmEnrollment(db, userId, totpCode(begin.secret));
		if (!confirm.ok) throw new Error('confirmation failed');

		const ev = event('/login/link', { token: await sentLink() });
		expect(await run(linkPage.actions.use, ev)).toEqual({ status: 303, location: '/login/totp' });
		expect(ev.cookies.get(TOTP_CHALLENGE_COOKIE)).toBeTruthy();
		expect(ev.cookies.get('session')).toBeUndefined();
		expect(await db.select().from(sessions)).toHaveLength(0);
	});

	it('refuses the 51st attempt from one address', async () => {
		for (let i = 0; i < 50; i++) {
			const res = await run(linkPage.actions.use, event('/login/link', { token: `guess${i}` }));
			expect(res.status).toBe(400);
		}
		const res = await run(linkPage.actions.use, event('/login/link', { token: await sentLink() }));
		expect(res.status).toBe(429);
	});
});
