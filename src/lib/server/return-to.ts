import type { Cookies } from '@sveltejs/kit';

// Where to send someone once they have signed in, for the one page that has
// to survive a trip through sign-in: the page where a writer allows an outside
// app, which the app opens for them. The place is remembered in a short-lived
// cookie when the sign-in redirect happens and taken back out when a session
// is created, whichever way they signed in.

export const RETURN_TO_COOKIE = 'return_to';
const MAX_AGE_SECONDS = 10 * 60;
const MAX_LENGTH = 4000;

// Only this page may be returned to. A fixed list, so the cookie can never
// send anyone to another site or to an arbitrary page of this one.
const RETURNABLE_PATHS: ReadonlySet<string> = new Set(['/oauth/authorize']);

// The path and query to return to, or null when the value is not one of the
// returnable pages on this site.
export function safeReturnTo(value: string | null | undefined): string | null {
	if (!value || value.length > MAX_LENGTH) return null;
	// One leading slash only: "//host" and "/\host" are other sites to a browser.
	if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
	let url: URL;
	try {
		url = new URL(value, 'http://self.invalid');
	} catch {
		return null;
	}
	if (url.origin !== 'http://self.invalid' || !RETURNABLE_PATHS.has(url.pathname)) return null;
	return url.pathname + url.search;
}

export function isReturnablePath(pathname: string): boolean {
	return RETURNABLE_PATHS.has(pathname);
}

// The Set-Cookie value that remembers the page, for the sign-in redirect.
export function rememberReturnTo(cookies: Cookies, url: URL): string | null {
	const target = safeReturnTo(url.pathname + url.search);
	if (!target) return null;
	return cookies.serialize(RETURN_TO_COOKIE, target, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		maxAge: MAX_AGE_SECONDS
	});
}

// Call when a session has just been created. Returns where to go, and forgets
// it, so it is used once.
export function takeReturnTo(cookies: Cookies): string | null {
	const stored = cookies.get(RETURN_TO_COOKIE);
	if (stored === undefined) return null;
	cookies.delete(RETURN_TO_COOKIE, { path: '/' });
	return safeReturnTo(stored);
}
