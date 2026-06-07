// The category tint tokens both colour pickers offer (the plan sidebar and the
// universe settings editor), and the only colours a category may hold. Tokens,
// not arbitrary CSS, so a colour cannot inject style, and one list keeps the
// two pickers and the server validation in step. Each token is defined per
// theme in tokens.css. Order is the picker order, roughly around the wheel.
export const CATEGORY_COLORS = [
	{ token: 'var(--cat-red)', label: 'Red' },
	{ token: 'var(--cat-amber)', label: 'Amber' },
	{ token: 'var(--cat-lime)', label: 'Lime' },
	{ token: 'var(--cat-green)', label: 'Green' },
	{ token: 'var(--cat-teal)', label: 'Teal' },
	{ token: 'var(--cat-cyan)', label: 'Cyan' },
	{ token: 'var(--cat-blue)', label: 'Blue' },
	{ token: 'var(--cat-violet)', label: 'Violet' },
	{ token: 'var(--cat-fuchsia)', label: 'Fuchsia' },
	{ token: 'var(--cat-rose)', label: 'Rose' }
];

export const CATEGORY_PALETTE = CATEGORY_COLORS.map((color) => color.token);

// A category colour is valid when it clears the colour (null) or is one of the
// palette tokens the pickers offer.
export function isCategoryColor(color: string | null): boolean {
	return color === null || CATEGORY_PALETTE.includes(color);
}

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
