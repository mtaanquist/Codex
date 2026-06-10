// The Assistant replying in a review thread it opened: the author has added a
// comment and the Assistant answers through its scoped tools (reply_in_thread,
// and update_suggestion when the thread discusses one of its suggestions).
// The gateway prepends the persona and the surface adds the assembled world
// context; this is the task turn carrying the thread itself.

const EXCERPT_MARGIN = 600;

// The scene text around the thread's anchor, so the reply is grounded in the
// passage under discussion without sending the whole scene. Falls back to the
// scene's head when there is no anchor (a whole-scene thread).
export function excerptAround(body: string, anchor: { start: number; end: number } | null): string {
	if (!anchor) return body.slice(0, EXCERPT_MARGIN * 2);
	const from = Math.max(0, anchor.start - EXCERPT_MARGIN);
	const to = Math.min(body.length, anchor.end + EXCERPT_MARGIN);
	const head = from > 0 ? '...' : '';
	const tail = to < body.length ? '...' : '';
	return `${head}${body.slice(from, to)}${tail}`;
}

export type ReviewReplyInput = {
	sceneTitle: string | null;
	// The passage under discussion, already excerpted by the caller.
	excerpt: string;
	// Oldest first, with display labels (Author, the Assistant's own name, or
	// a reviewer's name).
	transcript: { author: string; body: string }[];
	// Set when the thread discusses one of the Assistant's suggestions.
	suggestion: { original: string; replacement: string } | null;
};

export function buildReviewReplyMessage(input: ReviewReplyInput): string {
	const title = (input.sceneTitle ?? '').trim() || 'this scene';
	const parts: string[] = [
		`The author has replied in a review thread you opened on the scene "${title}". The passage under discussion:`,
		'',
		input.excerpt,
		''
	];
	if (input.suggestion) {
		parts.push(
			'The thread discusses your pending suggested edit:',
			`- It replaces: ${input.suggestion.original}`,
			`- With: ${input.suggestion.replacement || '(deletes the passage)'}`,
			''
		);
	}
	parts.push('The thread so far:', '');
	for (const turn of input.transcript) {
		parts.push(`${turn.author}: ${turn.body}`);
	}
	parts.push(
		'',
		'Answer the author through reply_in_thread; keep it brief and concrete.' +
			(input.suggestion
				? ' If they ask for a change to your suggestion, revise it with update_suggestion and say in your reply what you changed.'
				: '') +
			' Do not leave new comments elsewhere or touch anything outside this thread.'
	);
	return parts.join('\n');
}
