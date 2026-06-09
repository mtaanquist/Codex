// The continuation instruction: continue the writer's prose from where it
// stops. The gateway prepends the persona message; this is the task turn. No
// tools and no assembled world context in the first cut - just the preceding
// prose the client sends - so it stays fast for an as-you-write feel.

export function buildContinuationMessage(textBefore: string): string {
	return [
		'Continue the following prose naturally from exactly where it ends.',
		'Reply with only the continuation: no preamble, no quotation marks, and do not repeat any of the existing text.',
		'Match the established voice and tense. Keep it to a sentence or two unless the passage clearly calls for more.',
		'',
		'---',
		textBefore
	].join('\n');
}
