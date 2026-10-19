import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isRedirect } from '@sveltejs/kit';

// The hook only touches the database to validate a session cookie; these
// requests carry none (or a stale one), so the session check is stubbed.
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/auth', () => ({
	SESSION_COOKIE: 'session',
	validateSession: vi.fn(async () => null)
}));
vi.mock('$lib/server/log', () => ({ logEvent: vi.fn() }));

const { validateSession } = await import('$lib/server/auth');
const { logEvent } = await import('$lib/server/log');
const { handle, handleError } = await import('./hooks.server');

function request(
	path: string,
	cookie?: string,
	origin = 'http://localhost',
	{ method = 'GET', isDataRequest = false } = {}
) {
	const resolve = vi.fn(async () => new Response('ok'));
	const cookies = {
		get: vi.fn(() => cookie),
		delete: vi.fn(),
		serialize: vi.fn((name: string, value: string) => `${name}=${value}; Path=/; Max-Age=0`)
	};
	const url = new URL(`${origin}${path}`);
	const event = {
		url,
		request: new Request(url, { method }),
		isDataRequest,
		isRemoteRequest: false,
		cookies,
		locals: {}
	};
	return { event, resolve, cookies };
}

// The outcome of a request: 'resolved' when it reached the route, or the
// redirect target, whether returned as a 303 or thrown for SvelteKit to answer.
async function outcome(path: string, cookie?: string) {
	const { event, resolve } = request(path, cookie);
	let response: Response;
	try {
		response = await handle({ event, resolve } as never);
	} catch (err) {
		if (isRedirect(err)) return `${err.status} ${err.location}`;
		throw err;
	}
	if (response.status === 303) return `303 ${response.headers.get('location')}`;
	expect(resolve).toHaveBeenCalledTimes(1);
	return 'resolved';
}

const PROTECTED = [
	'/api/scenes/2f1c6a7e-3b4d-4c5e-8f90-1a2b3c4d5e6f',
	'/api/notes',
	'/api/passkeys/register-options',
	'/api/universes/u/prose-replace',
	'/admin',
	'/admin/users',
	'/stories/x',
	'/universes/x',
	'/settings',
	// Near misses on the public paths and prefixes.
	'/assets',
	'/assetsX',
	'/assetsX/file',
	'/artifacts',
	'/review',
	'/docsx',
	'/loginx',
	'/signup/extra',
	'/healthz/x'
];

const PUBLIC = [
	'/',
	'/login',
	'/login/totp',
	'/signup',
	'/verify-email',
	'/forgot-password',
	'/reset-password',
	'/cancel-deletion',
	'/confirm-email-change',
	'/review-email-opt-out',
	'/api/passkeys/signin-options',
	'/api/passkeys/signin',
	'/docs',
	'/healthz',
	'/@writer',
	'/@writer/a-story',
	'/assets/2f1c6a7e-3b4d-4c5e-8f90-1a2b3c4d5e6f',
	'/artifacts/abc',
	'/review/token',
	'/docs/getting-started'
];

describe('handle without a session', () => {
	beforeEach(() => {
		vi.mocked(validateSession).mockClear();
	});

	it.each(PROTECTED)('sends %s to the sign-in page', async (path) => {
		expect(await outcome(path)).toBe('303 /login');
	});

	it.each(PUBLIC)('lets %s through', async (path) => {
		expect(await outcome(path)).toBe('resolved');
	});

	it('clears a stale session cookie and still refuses a protected path', async () => {
		const { event, resolve, cookies } = request('/stories/x', 'stale-token');
		const response: Response = await handle({ event, resolve } as never);
		expect(response.status).toBe(303);
		expect(response.headers.get('location')).toBe('/login');
		expect(validateSession).toHaveBeenCalledTimes(1);
		expect(cookies.delete).toHaveBeenCalledWith('session', { path: '/' });
		expect(response.headers.get('set-cookie')).toMatch(/^session=; .*Max-Age=0/);
		expect(resolve).not.toHaveBeenCalled();
	});

	it.each([
		['a data request', { isDataRequest: true }],
		['a form post', { method: 'POST' }]
	])('throws the redirect for %s so SvelteKit answers it', async (_label, options) => {
		const { event, resolve } = request('/stories/x', undefined, undefined, options);
		await expect(handle({ event, resolve } as never)).rejects.toSatisfy(
			(err) => isRedirect(err) && err.location === '/login'
		);
	});
});

describe('security headers', () => {
	async function headersFor(path: string, origin?: string) {
		const { event, resolve } = request(path, undefined, origin);
		const response: Response = await handle({ event, resolve } as never);
		return response.headers;
	}

	it.each(['/', '/healthz', '/assets/2f1c6a7e-3b4d-4c5e-8f90-1a2b3c4d5e6f'])(
		'sets the baseline headers on %s',
		async (path) => {
			const headers = await headersFor(path);
			expect(headers.get('x-content-type-options')).toBe('nosniff');
			expect(headers.get('referrer-policy')).toBe('same-origin');
			expect(headers.get('x-frame-options')).toBe('DENY');
		}
	);

	it('sets them on the signed-out redirect to the sign-in page', async () => {
		const headers = await headersFor('/stories/x', 'https://codex.example');
		expect(headers.get('location')).toBe('/login');
		expect(headers.get('x-frame-options')).toBe('DENY');
		expect(headers.get('x-content-type-options')).toBe('nosniff');
		expect(headers.get('referrer-policy')).toBe('same-origin');
		expect(headers.get('strict-transport-security')).toBe('max-age=31536000');
	});

	it('sets them on the signed-in redirect away from sign-in', async () => {
		vi.mocked(validateSession).mockResolvedValueOnce({ user: {}, session: {} } as never);
		const { event, resolve } = request('/login', 'live-token');
		const response: Response = await handle({ event, resolve } as never);
		expect(response.status).toBe(303);
		expect(response.headers.get('location')).toBe('/');
		expect(response.headers.get('x-frame-options')).toBe('DENY');
		expect(response.headers.get('set-cookie')).toBeNull();
	});

	it('sends HSTS over HTTPS only', async () => {
		expect((await headersFor('/')).get('strict-transport-security')).toBeNull();
		expect((await headersFor('/', 'https://codex.example')).get('strict-transport-security')).toBe(
			'max-age=31536000'
		);
	});
});

describe('handleError', () => {
	const event = { request: { method: 'GET' }, url: new URL('http://localhost/stories/x') };

	it('logs the stack of a server fault', () => {
		const error = new Error('boom');
		handleError({ error, event, status: 500, message: 'Internal Error' } as never);
		expect(logEvent).toHaveBeenCalledWith(
			'error',
			'request.error',
			expect.objectContaining({ message: 'boom', stack: error.stack })
		);
	});
});
