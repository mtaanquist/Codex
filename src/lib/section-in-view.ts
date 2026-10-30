// The section of a long page the reader is in, for its "On this page" list:
// the last one whose top has scrolled up to the line just below the top bar.
// Above the first section, none is.
export function sectionInView(tops: { id: string; top: number }[], line: number): string | null {
	let current: string | null = null;
	for (const { id, top } of tops) if (top <= line) current = id;
	return current;
}
