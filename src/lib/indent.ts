// Per-paragraph block indent, riding in the markdown the way \center does: a
// paragraph that starts with \indent (or \indent2, \indent3, ...) is shifted
// to the right by that many levels in the editor, the reading pages, EPUB, and
// PDF, and exports round-trip the marker as plain text. Level 0 has no marker.
// It sits after any alignment marker, so an aligned paragraph can also indent.

export const MAX_INDENT = 6;
// The width of one indent level.
export const INDENT_STEP_EM = 1.5;

const PREFIX = /^\\indent(\d+)?(?:\s+|$)/;

// The indent level a paragraph's first line declares (after any alignment
// marker has been removed), and how many characters the marker occupies.
export function indentOf(firstLine: string): { level: number; markerLength: number } | null {
	const match = PREFIX.exec(firstLine);
	if (!match) return null;
	const level = match[1] ? Math.min(Math.max(parseInt(match[1], 10), 1), MAX_INDENT) : 1;
	return { level, markerLength: match[0].length };
}

export function indentMarker(level: number): string {
	if (level <= 0) return '';
	const clamped = Math.min(level, MAX_INDENT);
	return clamped === 1 ? '\\indent ' : `\\indent${clamped} `;
}

// The CSS left margin a level renders as, shared by the markdown renderer and
// the editor decoration so they never drift.
export function indentMargin(level: number): string {
	return `margin-left: calc(${level} * ${INDENT_STEP_EM}em)`;
}
