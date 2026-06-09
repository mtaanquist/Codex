// The recap instruction ("catch me up"): summarise the story so far for a
// writer returning to a work in progress. The gateway prepends the persona
// message and the surface supplies the assembled story-so-far as context; this
// is the task turn. No tools - it summarises what is there, it does not write
// new prose. Shipped-fixed in v1 (see assistant.md).

export function buildRecapMessage(throughTitle: string | null): string {
	const through = throughTitle?.trim()
		? `up to and including the scene "${throughTitle.trim()}"`
		: 'so far';
	return [
		`Catch the writer up on their own story ${through}.`,
		'Write a concise recap in a few short paragraphs: the key events in order, where the characters stand, and any open threads left hanging.',
		'Draw only on the material provided. Summarise what is there - do not continue the story, invent events, or add anything that is not in the text.',
		'Write in the same language as the story.'
	].join('\n');
}
