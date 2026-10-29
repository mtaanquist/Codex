import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { isHttpError } from '@sveltejs/kit';
import type pg from 'pg';
import { users } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase } from './test-db';

// The rate limits on the public account routes (password reset, sign-up,
// passkey sign-in) and on search, called as the real handlers against the test
// database. The reset and sign-up limits answer exactly as a normal request
// does, so the tests watch the work behind them (mail queued, registration
// attempted) rather than the response.

process.env.APP_SECRET = process.env.APP_SECRET || 'route-limits-test-secret';

vi.mock('$lib/server/db', async () => {
	const { default: pgModule } = await import('pg');
	const { drizzle } = await import('drizzle-orm/node-postgres');
	const schemaModule = await import('../../src/lib/server/db/schema');
	const { TEST_DATABASE_URL } = await import('./test-db');
	const testPool = new pgModule.Pool({ connectionString: TEST_DATABASE_URL });
	return { db: drizzle(testPool, { schema: schemaModule }), pool: testPool };
});
vi.mock('$lib/server/jobs', () => ({ queueEmail: vi.fn(async () => undefined) }));
vi.mock('$lib/server/notify', () => ({ notifyAdmins: vi.fn(async () => undefined) }));
vi.mock('$lib/server/signup', async (importActual) => {
	const actual = await importActual<typeof import('$lib/server/signup')>();
	return { ...actual, registerUser: vi.fn(actual.registerUser) };
});
vi.mock('$lib/server/search', async (importActual) => {
	const actual = await importActual<typeof import('$lib/server/search')>();
	return { ...actual, searchAll: vi.fn(actual.searchAll) };
});

const { db, pool } = (await import('$lib/server/db')) as unknown as {
	db: Database;
	pool: pg.Pool;
};
const { resetRateLimits } = await import('$lib/server/rate-limit');
const { queueEmail } = await import('$lib/server/jobs');
const { registerUser } = await import('$lib/server/signup');
const { searchAll } = await import('$lib/server/search');
const forgotPage = await import('../../src/routes/forgot-password/+page.server');
const signupPage = await import('../../src/routes/signup/+page.server');
const signinOptions = await import('../../src/routes/api/passkeys/signin-options/+server');
const signin = await import('../../src/routes/api/passkeys/signin/+server');
const search = await import('../../src/routes/api/search/+server');

const EMAIL = 'limits@example.com';

function formEvent(path: string, fields: Record<string, string>, ip = '203.0.113.1') {
	const url = new URL(`http://localhost${path}`);
	const form = new FormData();
	for (const [key, value] of Object.entries(fields)) form.set(key, value);
	return {
		url,
		request: new Request(url, { method: 'POST', body: form }),
		cookies: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
		getClientAddress: () => ip
	};
}

function jsonEvent(path: string, body: unknown, ip = '203.0.113.1') {
	const url = new URL(`http://localhost${path}`);
	return {
		url,
		request: new Request(url, { method: 'POST', body: JSON.stringify(body) }),
		cookies: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
		getClientAddress: () => ip
	};
}

const forgot = (email: string, ip?: string) =>
	(forgotPage.actions.default as (e: unknown) => Promise<unknown>)(
		formEvent('/forgot-password', { email }, ip)
	);

const signup = (email: string, ip?: string) =>
	(signupPage.actions.default as (e: unknown) => Promise<unknown>)(
		formEvent('/signup', { email, password: 'long enough password', displayName: 'L' }, ip)
	);

// The status a handler answered with, whether it returned a Response or threw.
async function statusOf(run: () => unknown): Promise<number> {
	try {
		return ((await run()) as Response).status;
	} catch (err) {
		if (isHttpError(err)) return err.status;
		throw err;
	}
}

const options = (ip: string) =>
	statusOf(() => signinOptions.POST(jsonEvent('/api/passkeys/signin-options', {}, ip) as never));

const finish = (ip: string) =>
	statusOf(() => signin.POST(jsonEvent('/api/passkeys/signin', {}, ip) as never));

beforeAll(async () => {
	await ensureTestDatabase();
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query('truncate table users cascade');
	resetRateLimits();
	vi.mocked(queueEmail).mockClear();
	vi.mocked(registerUser).mockClear();
	vi.mocked(searchAll).mockClear();
	await db
		.insert(users)
		.values({ email: EMAIL, displayName: 'L', passwordHash: 'x', role: 'user' });
});

afterAll(async () => {
	await pool.end();
});

describe('forgot-password limits', () => {
	it('stops mailing one address after 5 requests, from any address', async () => {
		for (let i = 0; i < 5; i++) {
			expect(await forgot(EMAIL, `198.51.100.${i}`)).toEqual({ sent: true });
		}
		expect(queueEmail).toHaveBeenCalledTimes(5);
		expect(await forgot(EMAIL, '192.0.2.200')).toEqual({ sent: true });
		expect(queueEmail).toHaveBeenCalledTimes(5);
	});

	it('stops one client address after 20 requests across many emails', async () => {
		for (let i = 0; i < 20; i++) await forgot(`nobody${i}@example.com`);
		expect(await forgot(EMAIL)).toEqual({ sent: true });
		expect(queueEmail).not.toHaveBeenCalled();
		// Another client is unaffected.
		await forgot(EMAIL, '192.0.2.200');
		expect(queueEmail).toHaveBeenCalledTimes(1);
	});
});

describe('signup limits', () => {
	it('stops registering one email after 5 attempts, from any address', async () => {
		const email = 'fresh@example.com';
		for (let i = 0; i < 5; i++) await signup(email, `198.51.100.${i}`);
		expect(registerUser).toHaveBeenCalledTimes(5);
		expect(await signup(email, '192.0.2.200')).toMatchObject({ sent: true });
		expect(registerUser).toHaveBeenCalledTimes(5);
	});

	it('stops one client address after 20 attempts across many emails', async () => {
		for (let i = 0; i < 20; i++) await signup(`new${i}@example.com`);
		expect(registerUser).toHaveBeenCalledTimes(20);
		expect(await signup('one-more@example.com')).toMatchObject({ sent: true });
		expect(registerUser).toHaveBeenCalledTimes(20);
		await signup('one-more@example.com', '192.0.2.200');
		expect(registerUser).toHaveBeenCalledTimes(21);
	});
});

describe('passkey sign-in limits', () => {
	it('refuses the 31st options request from one address', async () => {
		for (let i = 0; i < 30; i++) expect(await options('203.0.113.1')).toBe(200);
		expect(await options('203.0.113.1')).toBe(429);
		expect(await options('192.0.2.200')).toBe(200);
	});

	it('refuses the 31st sign-in attempt from one address', async () => {
		for (let i = 0; i < 30; i++) expect(await finish('203.0.113.1')).toBe(400);
		expect(await finish('203.0.113.1')).toBe(429);
		expect(await finish('192.0.2.200')).toBe(400);
	});

	it('shares one budget between the options and sign-in steps', async () => {
		for (let i = 0; i < 30; i++) await options('203.0.113.1');
		expect(await finish('203.0.113.1')).toBe(429);
	});
});

describe('search limit', () => {
	const query = (userId: string) =>
		search.GET({
			url: new URL('http://localhost/api/search?q=anything'),
			locals: { user: { id: userId } }
		} as never) as Promise<Response>;

	it('stops searching for one user after 120 requests a minute', async () => {
		const [user] = await db.select({ id: users.id }).from(users);
		const other = '00000000-0000-4000-8000-000000000001';
		for (let i = 0; i < 120; i++) await query(user.id);
		expect(searchAll).toHaveBeenCalledTimes(120);
		const res = await query(user.id);
		expect(await res.json()).toEqual({ results: [] });
		expect(searchAll).toHaveBeenCalledTimes(120);
		// Keyed by user: someone else on the same server still searches.
		await query(other);
		expect(searchAll).toHaveBeenCalledTimes(121);
	});
});
