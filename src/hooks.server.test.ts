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

function request(path: string, cookie?: string) {
	const resolve = vi.fn(async () => new Response('ok'));
	const cookies = { get: vi.fn(() => cookie), delete: vi.fn() };
	const event = { url: new URL(`http://localhost${path}`), cookies, locals: {} };
	return { event, resolve, cookies };
}

// The outcome of a request: 'resolved' when it reached the route, or the
// redirect target.
async function outcome(path: string, cookie?: string) {
	const { event, resolve } = request(path, cookie);
	try {
		await handle({ event, resolve } as never);
	} catch (err) {
		if (isRedirect(err)) return `${err.status} ${err.location}`;
		throw err;
	}
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
		await expect(handle({ event, resolve } as never)).rejects.toSatisfy(
			(err) => isRedirect(err) && err.location === '/login'
		);
		expect(validateSession).toHaveBeenCalledTimes(1);
		expect(cookies.delete).toHaveBeenCalledWith('session', { path: '/' });
		expect(resolve).not.toHaveBeenCalled();
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
