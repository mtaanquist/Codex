// How the reading pages name an author. Wherever the reader chrome names them -
// the path crumb and the footer's "Published by" line - it is the pen name if
// they set one, otherwise their display name, never the raw handle. The handle
// keeps appearing where it is an address: the URL and the shelf header.

export type AuthorIdentity = {
	penName?: string | null;
	displayName?: string | null;
};

/** The author's name for the reader, or an empty string when neither is set. */
export function authorName(identity: AuthorIdentity | null | undefined): string {
	if (!identity) return '';
	return identity.penName?.trim() || identity.displayName?.trim() || '';
}

/** The author's name, falling back to the handle as an address of last resort. */
export function authorNameOrHandle(
	identity: AuthorIdentity | null | undefined,
	handle: string
): string {
	return authorName(identity) || `@${handle}`;
}

/** Two-letter initials for the shelf's avatar when there is no picture. */
export function authorInitials(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	const first = parts[0]?.[0] ?? '';
	const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
	return (first + last).toUpperCase() || '?';
}
