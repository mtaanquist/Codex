// Shared display formatting for dates and API errors, so each component does
// not re-implement its own variant.

/** "Jun 11, 2026, 9:41 AM": timestamps on cards, lists, and settings rows. */
export function formatDateTime(date: Date | string): string {
	return new Date(date).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** "Jun 11, 2026": date-only rows (admin lists). */
export function formatDate(date: Date | string): string {
	return new Date(date).toLocaleDateString(undefined, {
		year: 'numeric',
		month: 'short',
		day: 'numeric'
	});
}

/** "just now", "5m", "3h", "2d", then the date: compact recency badges. */
export function relativeShort(date: Date | string): string {
	const then = new Date(date);
	const minutes = Math.floor((Date.now() - then.getTime()) / 60_000);
	if (minutes < 1) return 'just now';
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d`;
	return then.toLocaleDateString();
}

/** The message from a failed API response, or the fallback. */
export async function apiErrorMessage(response: Response, fallback: string): Promise<string> {
	const body = (await response.json().catch(() => null)) as { message?: string } | null;
	return body?.message ?? fallback;
}
