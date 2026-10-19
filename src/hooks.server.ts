import {
	redirect,
	type Handle,
	type HandleServerError,
	type RequestEvent,
	type ServerInit
} from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { SESSION_COOKIE, validateSession } from '$lib/server/auth';
import { logEvent } from '$lib/server/log';
import { assertOriginConfigured } from '$lib/server/origin';

export const init: ServerInit = () => {
	assertOriginConfigured();
};

const PUBLIC_PATHS = new Set([
	// The landing page; the root route shows the library once signed in.
	'/',
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
	// A guest reviewer's unsubscribe link; it guards itself on the signed
	// token it carries.
	'/review-email-opt-out',
	// Passkey sign-in runs before a session exists; the endpoints guard
	// themselves on the signed challenge cookie.
	'/api/passkeys/signin-options',
	'/api/passkeys/signin',
	// The help pages. The question mark in the bar is there for a guest
	// reviewer and a reader too, and neither has an account.
	'/docs',
	// Liveness probe for the reverse proxy and orchestrators; no auth.
	'/healthz'
]);
// Pages a signed-in user has no reason to see; bounce them home instead.
const AUTH_PATHS = new Set(['/login', '/signup']);
// Reader pages are public; assets and export downloads check publication
// state themselves, and review pages guard on the magic-link token.
const PUBLIC_PREFIXES = ['/@', '/assets/', '/artifacts/', '/review/', '/docs/'];

// Set on every response that passes through handle, endpoints included.
// adapter-node serves the built static files (/_app/immutable and static/)
// before handle runs, so those do not get them. The Content-Security-Policy for
// pages (scripts and frame-ancestors) comes from kit.csp in svelte.config.js.
// HSTS is left off plain HTTP so a self-hosted install without TLS is not
// pinned to HTTPS. It skips includeSubDomains because sibling hosts on a
// self-hoster's domain may not serve HTTPS.
function setSecurityHeaders(headers: Headers, url: URL) {
	headers.set('X-Content-Type-Options', 'nosniff');
	headers.set('Referrer-Policy', 'same-origin');
	headers.set('X-Frame-Options', 'DENY');
	if (url.protocol === 'https:') headers.set('Strict-Transport-Security', 'max-age=31536000');
}

// A redirect thrown from handle bypasses resolve, so it would leave without
// the headers above. A page navigation gets a plain 303 built here instead.
// Data, remote and form-action requests still throw: SvelteKit answers those
// with JSON its client reads, which a plain 303 would break.
function redirectFromHook(event: RequestEvent, location: string, staleCookie: boolean): Response {
	const method = event.request.method;
	if (event.isDataRequest || event.isRemoteRequest || (method !== 'GET' && method !== 'HEAD')) {
		redirect(303, location);
	}
	const headers = new Headers({ location });
	// The stale-session delete is only applied by SvelteKit on its own
	// responses, so it is carried here by hand.
	if (staleCookie) {
		headers.append(
			'set-cookie',
			event.cookies.serialize(SESSION_COOKIE, '', { path: '/', maxAge: 0 })
		);
	}
	setSecurityHeaders(headers, event.url);
	return new Response(null, { status: 303, headers });
}

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.user = null;
	event.locals.session = null;

	const token = event.cookies.get(SESSION_COOKIE);
	let staleCookie = false;
	if (token) {
		const result = await validateSession(db, token);
		if (result) {
			event.locals.user = result.user;
			event.locals.session = result.session;
		} else {
			event.cookies.delete(SESSION_COOKIE, { path: '/' });
			staleCookie = true;
		}
	}

	if (
		!event.locals.user &&
		!PUBLIC_PATHS.has(event.url.pathname) &&
		!PUBLIC_PREFIXES.some((prefix) => event.url.pathname.startsWith(prefix))
	) {
		return redirectFromHook(event, '/login', staleCookie);
	}
	if (event.locals.user && AUTH_PATHS.has(event.url.pathname)) {
		return redirectFromHook(event, '/', false);
	}

	const response = await resolve(event);
	setSecurityHeaders(response.headers, event.url);
	return response;
};

// Server faults are logged as structured events with a request id; the client
// still gets only SvelteKit's safe message. Expected 404s are left as noise.
export const handleError: HandleServerError = ({ error, event, status, message }) => {
	if (status !== 404) {
		logEvent('error', 'request.error', {
			method: event.request.method,
			path: event.url.pathname,
			status,
			message: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined
		});
	}
	return { message };
};
