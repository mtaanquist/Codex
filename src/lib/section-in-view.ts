// The section of a long page the reader is in, for its "On this page" list:
// the last one whose top has scrolled up to the line just below the top bar.
// Above the first section, none is.
//
// At the bottom of the page the last sections can never reach the line, so
// there the one the reader jumped to wins if its top is in view, and
// otherwise the last one in view does.
export function sectionInView(
	tops: { id: string; top: number }[],
	line: number,
	bottom?: { viewBottom: number; target: string | null }
): string | null {
	if (bottom) {
		const shown = tops.filter(({ top }) => top < bottom.viewBottom);
		const target = shown.find(({ id }) => id === bottom.target);
		if (target) return target.id;
		if (shown.length > 0) return shown[shown.length - 1].id;
	}
	let current: string | null = null;
	for (const { id, top } of tops) if (top <= line) current = id;
	return current;
}
