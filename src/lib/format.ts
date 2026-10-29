// Shared display formatting for dates and API errors, so each component does
// not re-implement its own variant.

// Every date and number shown in the UI uses this locale, passed explicitly so
// server-rendered and browser-rendered output match. Lint bans toLocale* and
// Intl formatters outside this file.
export const DISPLAY_LOCALE = 'en-GB';

// The date helpers take the author's timezone (page.data.timeZone, from the
// root layout) so server-rendered and browser-rendered times match. Left out,
// they use the runtime's own zone.

/** "11 Jun 2026, 09:41": timestamps on cards, lists, and settings rows. */
export function formatDateTime(date: Date | string, timeZone?: string): string {
	return new Date(date).toLocaleString(DISPLAY_LOCALE, {
		dateStyle: 'medium',
		timeStyle: 'short',
		timeZone
	});
}

/** "11 Jun 2026": date-only rows (admin lists). */
export function formatDate(date: Date | string, timeZone?: string): string {
	return new Date(date).toLocaleDateString(DISPLAY_LOCALE, {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
		timeZone
	});
}

/** "11 June 2026": publication dates on the public shelf and book pages. */
export function formatLongDate(date: Date | string, timeZone?: string): string {
	return new Date(date).toLocaleDateString(DISPLAY_LOCALE, {
		day: 'numeric',
		month: 'long',
		year: 'numeric',
		timeZone
	});
}

/** "just now", "5m", "3h", "2d", then the date: compact recency badges. */
export function relativeShort(date: Date | string, timeZone?: string): string {
	const then = new Date(date);
	const minutes = Math.floor((Date.now() - then.getTime()) / 60_000);
	if (minutes < 1) return 'just now';
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d`;
	return formatDate(then, timeZone);
}

/** "09:41": time of day for rows already grouped under a date. */
export function formatTime(date: Date | string, timeZone?: string): string {
	return new Date(date).toLocaleTimeString(DISPLAY_LOCALE, {
		hour: '2-digit',
		minute: '2-digit',
		timeZone
	});
}

/** "2026-06-11": the calendar day an instant falls on, for grouping by day. */
export function dayKey(date: Date | string, timeZone?: string): string {
	const parts = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		timeZone
	}).formatToParts(new Date(date));
	const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
	return `${part('year')}-${part('month')}-${part('day')}`;
}

/** "W" for a "YYYY-MM-DD" calendar day: single-letter weekday strips. */
export function narrowWeekday(day: string): string {
	return new Date(`${day}T00:00:00Z`).toLocaleDateString(DISPLAY_LOCALE, {
		weekday: 'narrow',
		timeZone: 'UTC'
	});
}

/** "" for exactly one, "s" otherwise: `${n} scene${pluralSuffix(n)}`. */
export function pluralSuffix(n: number): string {
	return n === 1 ? '' : 's';
}

/** "1,234": grouped integers for counts shown in the UI. */
export function formatNumber(n: number): string {
	return n.toLocaleString(DISPLAY_LOCALE);
}

/** "950", "1.2k": compact counts for tight rows. Empty for non-positive. */
export function compactCount(n: number): string {
	if (n <= 0) return '';
	return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}

/** The message from a failed API response, or the fallback. */
export async function apiErrorMessage(response: Response, fallback: string): Promise<string> {
	const body = (await response.json().catch(() => null)) as { message?: string } | null;
	return body?.message ?? fallback;
}
