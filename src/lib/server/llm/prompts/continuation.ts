// The continuation instruction: continue the writer's prose from where it
// stops. The gateway prepends the persona message; this is the task turn. No
// tools and no assembled world context in the first cut - just the preceding
// prose the client sends - so it stays fast for an as-you-write feel.

import { estimateTokens } from '../context/assemble.ts';

// Provisional: a per-endpoint context-window setting will replace this. A short
// tail keeps prefill small, which is what makes the turnaround quick on a local
// model.
// Exported so the unit test can derive its bounds instead of restating them.
export const TAIL_BUDGET_TOKENS = 1500;

// The tail of the prose before the cursor, trimmed to the budget. Marks the cut
// the way a body excerpt does, and skips a partial first word so the prompt does
// not open mid-word. Exported for the unit test; pure.
export function continuationTail(textBefore: string): string {
	if (estimateTokens(textBefore) <= TAIL_BUDGET_TOKENS) return textBefore;
	const cut = textBefore.length - TAIL_BUDGET_TOKENS * 4;
	let tail = textBefore.slice(cut);
	const openedMidWord = /\S/.test(textBefore[cut - 1]) && /\S/.test(tail[0]);
	if (openedMidWord) {
		const firstBreak = tail.search(/\s/);
		if (firstBreak >= 0) tail = tail.slice(firstBreak);
	}
	return '[...] ' + tail.trimStart();
}

export function buildContinuationMessage(textBefore: string): string {
	return [
		'Continue the following prose naturally from exactly where it ends.',
		'Reply with only the continuation: no preamble, no quotation marks, and do not repeat any of the existing text.',
		'Match the established voice and tense. Keep it to a sentence or two unless the passage clearly calls for more.',
		'',
		'---',
		continuationTail(textBefore)
	].join('\n');
}
