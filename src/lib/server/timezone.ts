import type { Cookies } from '@sveltejs/kit';
import { TIMEZONE_COOKIE } from '#lib/timezone';

/** The author's timezone from the cookie, or UTC when it is missing or bad. */
export function requestTimeZone(cookies: Pick<Cookies, 'get'>): string {
	// cookies.get has already decoded the value.
	const requested = cookies.get(TIMEZONE_COOKIE) ?? '';
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
