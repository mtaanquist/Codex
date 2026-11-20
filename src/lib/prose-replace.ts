// Find and replace in prose, with the position arithmetic to carry scene
// marker anchors through the edit. Pure, no I/O; the server modules apply it
// to the database (the rename sweep and the story find and replace).

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export type MatchOptions = { matchCase: boolean; wholeWord: boolean };

// A match as offsets into the text. The end is kept rather than derived from
// the needle, since a case-insensitive match can differ from it in length.
export type TextMatch = { start: number; end: number };

/**
 * Every non-overlapping occurrence, in order. The whole-word boundary matches
 * mention detection: letters, digits, and underscores extend a word, so
 * "Alice" stays out of "Alicester" but matches in "Alice's".
 */
export function findMatches(body: string, find: string, options: MatchOptions): TextMatch[] {
	if (find === '') return [];
	const needle = escapeRegExp(find);
	const source = options.wholeWord ? `(?<![\\p{L}\\p{N}_])${needle}(?![\\p{L}\\p{N}_])` : needle;
	const pattern = new RegExp(source, options.matchCase ? 'gu' : 'giu');
	const matches: TextMatch[] = [];
	for (const match of body.matchAll(pattern)) {
		matches.push({ start: match.index, end: match.index + match[0].length });
	}
	return matches;
}

/**
 * Start offsets of every whole-word, case-sensitive occurrence (the rename
 * sweep's rule).
 */
export function wholeWordMatches(body: string, find: string): number[] {
	return findMatches(body, find, { matchCase: true, wholeWord: true }).map((m) => m.start);
}

export type AnchorRange = { anchorStart: number; anchorEnd: number };

/**
 * Maps one offset through the replacements: offsets before a match stand,
 * offsets after shift by the accumulated length difference, and offsets
 * inside a match clamp into the replacement.
 */
function mapOffset(offset: number, matches: TextMatch[], replaceLength: number): number {
	let shift = 0;
	for (const match of matches) {
		if (offset >= match.end) {
			shift += replaceLength - (match.end - match.start);
		} else if (offset > match.start) {
			return match.start + shift + Math.min(offset - match.start, replaceLength);
		} else {
			break;
		}
	}
	return offset + shift;
}

/**
 * Replaces the given matches (sorted, non-overlapping) and carries the anchors
 * along.
 */
export function replaceMatches<T extends AnchorRange>(
	body: string,
	matches: TextMatch[],
	replace: string,
	anchors: T[] = []
): { body: string; anchors: T[] } {
	if (matches.length === 0) return { body, anchors };
	let result = '';
	let cursor = 0;
	for (const match of matches) {
		result += body.slice(cursor, match.start) + replace;
		cursor = match.end;
	}
	result += body.slice(cursor);
	const moved = anchors.map((anchor) => ({
		...anchor,
		anchorStart: mapOffset(anchor.anchorStart, matches, replace.length),
		anchorEnd: mapOffset(anchor.anchorEnd, matches, replace.length)
	}));
	return { body: result, anchors: moved };
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
	const matches = findMatches(body, find, { matchCase: true, wholeWord: true });
	return { ...replaceMatches(body, matches, replace, anchors), count: matches.length };
}

/**
 * A short passage around a match for a preview list: up to `context`
 * characters either side, cut at a line break and at a word edge, with line
 * breaks inside shown as spaces.
 */
export function matchContext(
	body: string,
	match: TextMatch,
	context = 60
): { before: string; text: string; after: string } {
	let from = Math.max(0, match.start - context);
	const lineStart = body.lastIndexOf('\n', match.start - 1);
	if (lineStart >= from) from = lineStart + 1;
	else if (from > 0) {
		const space = body.indexOf(' ', from);
		if (space !== -1 && space < match.start) from = space + 1;
	}
	let to = Math.min(body.length, match.end + context);
	const lineEnd = body.indexOf('\n', match.end);
	if (lineEnd !== -1 && lineEnd <= to) to = lineEnd;
	else if (to < body.length) {
		const space = body.lastIndexOf(' ', to);
		if (space > match.end) to = space;
	}
	const flat = (text: string) => text.replace(/\s+/g, ' ');
	return {
		before:
			(from > 0 && body[from - 1] !== '\n' ? '...' : '') + flat(body.slice(from, match.start)),
		text: body.slice(match.start, match.end),
		after: flat(body.slice(match.end, to)) + (to < body.length && body[to] !== '\n' ? '...' : '')
	};
}
