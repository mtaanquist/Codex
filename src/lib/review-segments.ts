// Slices a scene's text into segments for the review manuscript: plain runs
// and highlighted runs covered by a thread's anchor. Shared by the guest
// review page and the author's feedback page.
export type ReviewSegment = { text: string; threadId: string | null };

export function reviewSegments(
	bodyMd: string,
	threads: { id: string; anchor: { start: number; end: number } | null }[]
): ReviewSegment[] {
	const anchored = threads.filter(
		(thread): thread is { id: string; anchor: { start: number; end: number } } =>
			thread.anchor !== null
	);
	const points = new Set([0, bodyMd.length]);
	for (const thread of anchored) {
		points.add(Math.min(thread.anchor.start, bodyMd.length));
		points.add(Math.min(thread.anchor.end, bodyMd.length));
	}
	const sorted = [...points].sort((a, b) => a - b);
	const parts: ReviewSegment[] = [];
	for (let i = 0; i < sorted.length - 1; i++) {
		const from = sorted[i];
		const to = sorted[i + 1];
		const covering = anchored.find(
			(thread) => thread.anchor.start <= from && thread.anchor.end >= to
		);
		parts.push({ text: bodyMd.slice(from, to), threadId: covering?.id ?? null });
	}
	return parts;
}
