// The author's timezone travels to the server in this cookie (set by the root
// layout), so server-rendered times and day boundaries match the browser's.
export const TIMEZONE_COOKIE = 'codex-tz';

/** The browser's IANA timezone, for instance "Europe/Copenhagen". */
export function browserTimeZone(): string {
	// Reads the browser's timezone, not display formatting.
	// eslint-disable-next-line no-restricted-syntax
	return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
