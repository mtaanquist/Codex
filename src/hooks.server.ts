import { redirect, type RequestEvent } from '@sveltejs/kit';
import type { Handle, HandleServerError, ServerInit } from '@sveltejs/kit/hooks';
import { db } from '#lib/server/db';
import { SESSION_COOKIE, validateSession } from '#lib/server/auth';
import { errorFields, logEvent } from '#lib/server/log';
import { assertOriginConfigured, publicOrigin } from '#lib/server/origin';
import { dev } from '$app/env';
import { isForbiddenCrossSiteForm } from '#lib/server/csrf';
import { rememberReturnTo } from '#lib/server/return-to';

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
	// Asking for a sign-in link by email, and using one.
	'/login/link',
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
// Routes that other programs call with their own credential, or with none:
// the MCP endpoint (bearer token only, checked by the route itself) and
// the OAuth endpoints an outside app talks to before and after a writer allows
// it. The session cookie is not read for these at all, so a browser session
// can never stand in for the credential they ask for.
const NO_SESSION_PATHS = new Set(['/api/mcp', '/oauth/register', '/oauth/token', '/oauth/revoke']);
const NO_SESSION_PREFIXES = [
	'/.well-known/oauth-authorization-server',
	'/.well-known/oauth-protected-resource'
];

function ignoresSession(pathname: string): boolean {
	return (
		NO_SESSION_PATHS.has(pathname) ||
		NO_SESSION_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix + '/'))
	);
}

// Pages a signed-in user has no reason to see; bounce them home instead.
const AUTH_PATHS = new Set(['/login', '/login/link', '/signup']);
// Reader pages are public; assets and export downloads check publication
// state themselves, and review pages guard on the magic-link token.
const PUBLIC_PREFIXES = ['/@', '/assets/', '/artifacts/', '/review/', '/docs/'];

// Set on every response that passes through handle, endpoints included.
// adapter-node serves the built static files (/_app/immutable and static/)
// before handle runs, so those do not get them. The Content-Security-Policy for
// pages (scripts and frame-ancestors) comes from the csp option in vite.config.ts.
// HSTS follows the configured ORIGIN, not the request URL, so a self-hosted
// install without TLS is never pinned to HTTPS: adapter-node can report https
// for a plain-HTTP request when no protocol header is set. It skips
// includeSubDomains because sibling hosts on a self-hoster's domain may not
// serve HTTPS.
function setSecurityHeaders(headers: Headers, url: URL) {
	headers.set('X-Content-Type-Options', 'nosniff');
	headers.set('Referrer-Policy', 'same-origin');
	headers.set('X-Frame-Options', 'DENY');
	if (new URL(publicOrigin(url)).protocol === 'https:') {
		headers.set('Strict-Transport-Security', 'max-age=31536000');
	}
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
	// A page that has to survive sign-in is remembered for afterwards.
	const returnTo = location === '/login' ? rememberReturnTo(event.cookies, event.url) : null;
	if (returnTo) headers.append('set-cookie', returnTo);
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

	// SvelteKit's own check is off (see vite.config.ts); like it, this one
	// only runs outside the dev server.
	if (
		!dev &&
		isForbiddenCrossSiteForm({
			method: event.request.method,
			contentType: event.request.headers.get('content-type'),
			origin: event.request.headers.get('origin'),
			selfOrigin: event.url.origin,
			pathname: event.url.pathname
		})
	) {
		const message = `Cross-site ${event.request.method} form submissions are forbidden`;
		const headers = new Headers({ 'content-type': 'text/plain' });
		setSecurityHeaders(headers, event.url);
		return new Response(message, { status: 403, headers });
	}

	if (ignoresSession(event.url.pathname)) {
		const response = await resolve(event);
		setSecurityHeaders(response.headers, event.url);
		return response;
	}

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
// still gets only SvelteKit's safe message. Kit 3 also passes expected errors
// here: error() throws, invalid remote arguments, and the router's 404s are the
// app working as intended. The framework's other refusals (an upload over
// BODY_SIZE_LIMIT, a POST with no matching action) stay logged, since they
// usually point at a setting or a client bug.
export const handleError: HandleServerError = ({ kind, error, event }) => {
	if (kind === 'app' || kind === 'validation') return;
	if (kind === 'framework' && error.status === 404) return;
	logEvent('error', 'request.error', {
		method: event.request.method,
		path: event.url.pathname,
		...(kind === 'framework'
			? { status: error.status, message: error.message }
			: { status: 500, ...errorFields(error) })
	});
};
