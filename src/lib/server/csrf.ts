// The cross-site form check, done here instead of by SvelteKit so two routes
// can be left out of it (the built-in check has no per-route exception and is
// switched off in vite.config.ts). The rule is SvelteKit's own: a POST, PUT,
// PATCH or DELETE that a plain HTML form could send (a form content type, or
// none) is refused unless its Origin header is this site's.
//
// The OAuth token and revoke endpoints must take form-encoded POSTs from other
// programs, which send no Origin or another site's. That is safe for those two
// because they never read the session cookie: a forged request from a browser
// carries nothing that the attacker did not already have.

const FORM_TYPES = new Set([
	'application/x-www-form-urlencoded',
	'multipart/form-data',
	'text/plain',
	// SvelteKit's own encoding for forms with files.
	'application/x-sveltekit-formdata'
]);
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const CROSS_SITE_FORM_PATHS: ReadonlySet<string> = new Set([
	'/oauth/token',
	'/oauth/revoke'
]);

export function isForbiddenCrossSiteForm(request: {
	method: string;
	contentType: string | null;
	origin: string | null;
	selfOrigin: string;
	pathname: string;
}): boolean {
	if (!MUTATING.has(request.method)) return false;
	if (request.origin === request.selfOrigin) return false;
	const type = request.contentType?.split(';', 1)[0].trim().toLowerCase() ?? '';
	if (type && !FORM_TYPES.has(type)) return false;
	return !CROSS_SITE_FORM_PATHS.has(request.pathname);
}
