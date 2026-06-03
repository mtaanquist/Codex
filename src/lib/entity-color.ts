const PALETTE = [
	'var(--cat-blue)',
	'var(--cat-violet)',
	'var(--cat-rose)',
	'var(--cat-green)',
	'var(--cat-amber)'
];

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
