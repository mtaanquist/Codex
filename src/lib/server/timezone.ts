import type { Cookies } from '@sveltejs/kit';
import { TIMEZONE_COOKIE } from '$lib/timezone';

/** The author's timezone from the cookie, or UTC when it is missing or bad. */
export function requestTimeZone(cookies: Pick<Cookies, 'get'>): string {
	let requested: string;
	try {
		requested = decodeURIComponent(cookies.get(TIMEZONE_COOKIE) ?? '');
	} catch {
		// A malformed percent-escape must fall back, not 500.
		requested = '';
	}
	return requested && isValidTimezone(requested) ? requested : 'UTC';
}

/** True when the string names a timezone the runtime knows. */
export function isValidTimezone(timezone: string): boolean {
	try {
		// A validity probe, not display formatting.
		// eslint-disable-next-line no-restricted-syntax
		new Intl.DateTimeFormat('en', { timeZone: timezone });
		return true;
	} catch {
		return false;
	}
}
