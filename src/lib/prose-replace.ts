// Whole-word replacement of an entity name in prose, with the position
// arithmetic to carry scene marker anchors through the edit. Pure, no I/O;
// the server module applies it to the database.

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Start offsets of every whole-word, case-sensitive occurrence. The word
 * boundary matches mention detection: letters, digits, and underscores
 * extend a word, so "Alice" stays out of "Alicester" but matches in
 * "Alice's".
 */
export function wholeWordMatches(body: string, find: string): number[] {
	if (find === '') return [];
	const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(find)}(?![\\p{L}\\p{N}_])`, 'gu');
	const positions: number[] = [];
	for (const match of body.matchAll(pattern)) {
		positions.push(match.index);
	}
	return positions;
}

export type AnchorRange = { anchorStart: number; anchorEnd: number };

/**
 * Maps one offset through the replacements: offsets before a match stand,
 * offsets after shift by the accumulated length difference, and offsets
 * inside a match clamp into the replacement.
 */
function mapOffset(offset: number, positions: number[], findLength: number, delta: number): number {
	let shifted = offset;
	for (const [index, position] of positions.entries()) {
		if (offset >= position + findLength) {
			shifted += delta;
		} else if (offset > position) {
			shifted = position + index * delta + Math.min(offset - position, findLength + delta);
			return shifted;
		} else {
			break;
		}
	}
	return shifted;
}

/**
 * Replaces every whole-word occurrence and carries the anchors along.
 * Returns the original body untouched when nothing matches.
 */
export function replaceWholeWord<T extends AnchorRange>(
	body: string,
	find: string,
	replace: string,
	anchors: T[] = []
): { body: string; count: number; anchors: T[] } {
	const positions = wholeWordMatches(body, find);
	if (positions.length === 0) return { body, count: 0, anchors };

	let result = '';
	let cursor = 0;
	for (const position of positions) {
		result += body.slice(cursor, position) + replace;
		cursor = position + find.length;
	}
	result += body.slice(cursor);

	const delta = replace.length - find.length;
	const moved = anchors.map((anchor) => ({
		...anchor,
		anchorStart: mapOffset(anchor.anchorStart, positions, find.length, delta),
		anchorEnd: mapOffset(anchor.anchorEnd, positions, find.length, delta)
	}));
	return { body: result, count: positions.length, anchors: moved };
}
