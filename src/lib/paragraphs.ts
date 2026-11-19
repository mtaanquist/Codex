// Paragraphs in a scene body: the runs of text between blank lines. The guided
// pass over a pattern note shows each change inside its whole paragraph, and the
// re-read after an accept looks at that paragraph and its neighbours. Pure, so
// the browser and the server share it.

export type Span = { start: number; end: number };

const BLANK_LINES = /\n[ \t]*\n\s*/g;

// Every paragraph's [start, end) in the body, in order, without the blank lines
// around it.
export function paragraphSpans(body: string): Span[] {
	const spans: Span[] = [];
	let from = 0;
	const push = (start: number, end: number) => {
		while (start < end && /\s/.test(body[start])) start++;
		while (end > start && /\s/.test(body[end - 1])) end--;
		if (end > start) spans.push({ start, end });
	};
	for (const match of body.matchAll(BLANK_LINES)) {
		push(from, match.index);
		from = match.index + match[0].length;
	}
	push(from, body.length);
	return spans;
}

// The paragraphs a range touches, widened by `neighbours` paragraphs on each
// side, as one span. A range that falls between paragraphs (or an empty one at
// a gap) counts as touching the next paragraph, or the last one at the end. An
// empty body gives an empty span.
export function paragraphWindow(body: string, start: number, end: number, neighbours = 0): Span {
	const spans = paragraphSpans(body);
	if (spans.length === 0) return { start: 0, end: body.length };
	let first = spans.findIndex((span) => span.end > start || (span.end === start && start === end));
	if (first === -1) first = spans.length - 1;
	let last = first;
	while (last + 1 < spans.length && spans[last + 1].start < end) last++;
	const from = Math.max(0, first - neighbours);
	const to = Math.min(spans.length - 1, last + neighbours);
	return { start: spans[from].start, end: spans[to].end };
}
