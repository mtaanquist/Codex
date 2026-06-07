// The admin sections, each its own page under /admin/<section>; the
// overview rests on /admin itself, so 'overview' is not a valid URL slug.
export const SECTIONS = [
	'overview',
	'users',
	'ai',
	'usage',
	'published',
	'backups',
	'audit',
	'instance'
] as const;
export type Section = (typeof SECTIONS)[number];

export function isSectionSlug(s: string): s is Exclude<Section, 'overview'> {
	return s !== 'overview' && SECTIONS.includes(s as Section);
}
