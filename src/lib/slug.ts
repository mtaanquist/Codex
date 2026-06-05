// Slug helpers shared by URLs and export filenames. Used from the worker
// (export bundles), so keep this dependency-free.

export const SLUG_MAX = 60;

export function slugify(text: string | null, fallback: string): string {
	const slug = (text ?? '')
		.toLowerCase()
		.normalize('NFKD')
		// Drop combining marks so accented letters fold to their base form.
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, SLUG_MAX)
		.replace(/-+$/, '');
	return slug || fallback;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUuid(value: string): boolean {
	return UUID_PATTERN.test(value);
}

/**
 * A slug an author may set by hand: lowercase letters, digits, and inner
 * hyphens. Never uuid-shaped, so a slug can never shadow an id lookup.
 */
export function isValidSlug(value: string): boolean {
	return (
		value.length <= SLUG_MAX && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value) && !isUuid(value)
	);
}
