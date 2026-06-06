// The category tint tokens the plan sidebar's colour picker offers, and the
// only colours createCategory accepts (the universe settings editor uses its
// own hex swatch). Tokens, not arbitrary CSS, so a colour cannot inject style.
export const CATEGORY_PALETTE = [
	'var(--cat-blue)',
	'var(--cat-violet)',
	'var(--cat-rose)',
	'var(--cat-green)',
	'var(--cat-amber)'
];

const PALETTE = CATEGORY_PALETTE;

// Deterministic badge colour for an entity name, drawn from the category
// tint tokens.
export function entityColor(name: string): string {
	let hash = 0;
	for (const char of name) {
		hash = (hash * 31 + char.charCodeAt(0)) % 9973;
	}
	return PALETTE[hash % PALETTE.length];
}

export function entityLetter(name: string): string {
	return (name.trim()[0] ?? '?').toUpperCase();
}
