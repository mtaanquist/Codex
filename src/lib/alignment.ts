// Per-paragraph alignment, riding in the markdown itself the way \page
// does: a paragraph that starts with \center, \right, or \justify renders
// aligned that way in the editor, the reading pages, EPUB, and PDF, and
// exports round-trip the marker as plain text. Left needs no marker.

export type Alignment = 'left' | 'center' | 'right' | 'justify';
export const ALIGNMENTS: Alignment[] = ['left', 'center', 'right', 'justify'];

const PREFIX = /^\\(center|right|justify)(?:\s+|$)/;

// The alignment a paragraph's first line declares, and how many characters
// the marker (with its trailing space) occupies.
export function alignmentOf(
	firstLine: string
): { align: Exclude<Alignment, 'left'>; markerLength: number } | null {
	const match = PREFIX.exec(firstLine);
	if (!match) return null;
	return { align: match[1] as Exclude<Alignment, 'left'>, markerLength: match[0].length };
}

export function alignmentMarker(align: Alignment): string {
	return align === 'left' ? '' : `\\${align} `;
}
