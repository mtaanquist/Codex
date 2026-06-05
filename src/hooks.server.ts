import { redirect, type Handle, type HandleServerError } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { SESSION_COOKIE, validateSession } from '$lib/server/auth';
import { logEvent } from '$lib/server/log';

const PUBLIC_PATHS = new Set([
	'/login',
	// The two-factor challenge runs before a session exists; it guards itself on
	// the signed challenge cookie.
	'/login/totp',
	'/signup',
	'/verify-email',
	'/forgot-password',
	'/reset-password',
	'/cancel-deletion',
	'/confirm-email-change',
	// Passkey sign-in runs before a session exists; the endpoints guard
	// themselves on the signed challenge cookie.
	'/api/passkeys/signin-options',
	'/api/passkeys/signin',
	// Liveness probe for the reverse proxy and orchestrators; no auth.
	'/healthz'
]);
// Pages a signed-in user has no reason to see; bounce them home instead.
const AUTH_PATHS = new Set(['/login', '/signup']);
// Reader pages are public; assets and export downloads check publication
// state themselves, and review pages guard on the magic-link token.
const PUBLIC_PREFIXES = ['/@', '/assets/', '/artifacts/', '/review/'];

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.user = null;
	event.locals.session = null;

	const sessionId = event.cookies.get(SESSION_COOKIE);
	if (sessionId) {
		const result = await validateSession(db, sessionId);
		if (result) {
			event.locals.user = result.user;
			event.locals.session = result.session;
		} else {
			event.cookies.delete(SESSION_COOKIE, { path: '/' });
		}
	}

	if (
		!event.locals.user &&
		!PUBLIC_PATHS.has(event.url.pathname) &&
		!PUBLIC_PREFIXES.some((prefix) => event.url.pathname.startsWith(prefix))
	) {
		redirect(303, '/login');
	}
	if (event.locals.user && AUTH_PATHS.has(event.url.pathname)) {
		redirect(303, '/');
	}

	return resolve(event);
};

// Server faults are logged as structured events with a request id; the client
// still gets only SvelteKit's safe message. Expected 404s are left as noise.
export const handleError: HandleServerError = ({ error, event, status, message }) => {
	if (status !== 404) {
		logEvent('error', 'request.error', {
			method: event.request.method,
			path: event.url.pathname,
			status,
			message: error instanceof Error ? error.message : String(error)
		});
	}
	return { message };
};
