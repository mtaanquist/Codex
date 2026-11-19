// The shape of an Assistant review request, shared by the client (the review
// modal and the action helpers) and the server (the endpoints, the prompt
// builder, and the background job), so both ends agree on the wire. A review
// runs over one level and checks a set of categories.
//
// Keep this module free of server-only and framework imports: it is pulled into
// the browser bundle and into the worker.

export type ReviewLevel = 'scene' | 'chapter' | 'story';

// The exhaustive review categories. An empty set is the sparing "general notes"
// pass (a few high-value observations); all three together is the full copyedit,
// which also runs the cross-scene consistency pass at story or multi-scene scope.
export const REVIEW_CATEGORIES = ['mechanics', 'prose', 'lore'] as const;
export type ReviewCategory = (typeof REVIEW_CATEGORIES)[number];

// Narrows an unknown payload field to a clean, de-duplicated category list, in
// canonical order, so an endpoint can trust whatever a client sends.
export function parseCategories(value: unknown): ReviewCategory[] {
	if (!Array.isArray(value)) return [];
	return REVIEW_CATEGORIES.filter((category) => value.includes(category));
}

// All three categories selected: the full copyedit pass.
export function isFullReview(categories: ReviewCategory[]): boolean {
	return REVIEW_CATEGORIES.every((category) => categories.includes(category));
}

// The pattern pass a chapter or story review can add: look for habits that
// repeat across each chapter, or across the whole book at once. Only offered
// when the review covers the prose (see coversProse).
export type PatternScope = 'chapter' | 'book';

export function parsePatternScope(value: unknown): PatternScope | undefined {
	return value === 'chapter' || value === 'book' ? value : undefined;
}

// The sparing general pass, or any pass with the prose category.
export function coversProse(categories: ReviewCategory[]): boolean {
	return categories.length === 0 || categories.includes('prose');
}

// Human labels, used in the modal and in the review prompt's intro line.
export const CATEGORY_LABELS: Record<ReviewCategory, string> = {
	mechanics: 'spelling and grammar',
	prose: 'prose and style',
	lore: 'entities, continuity, and lore'
};
