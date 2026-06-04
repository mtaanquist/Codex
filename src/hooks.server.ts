import { redirect, type Handle } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { SESSION_COOKIE, validateSession } from '$lib/server/auth';

const PUBLIC_PATHS = new Set([
	'/login',
	'/signup',
	'/verify-email',
	'/forgot-password',
	'/reset-password',
	'/cancel-deletion'
]);
// Pages a signed-in user has no reason to see; bounce them home instead.
const AUTH_PATHS = new Set(['/login', '/signup']);
// Reader pages are public; assets check publication state themselves.
const PUBLIC_PREFIXES = ['/@', '/assets/'];

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
