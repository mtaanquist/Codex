// The reviewer instruction for a single-scene Assistant review. The gateway
// prepends the persona system message and the surface adds the assembled world
// context; this is the task turn that tells the Assistant to review one scene
// and leave its feedback through the staging tools (suggest_edit, leave_comment)
// rather than rewriting the prose. Shipped-fixed in v1 (see assistant.md).

// An open note the Assistant left on an earlier pass, carried into the next
// run so it does not repeat itself.
export type PriorNote = {
	kind: 'comment' | 'suggestion';
	// The passage a suggestion was anchored to; comments carry their quote
	// inside the body already.
	quote?: string;
	body: string;
};

// Keep each carried note short: the model needs enough to recognise its own
// note, not the full text.
const NOTE_CLAMP = 280;
function clamp(text: string): string {
	const trimmed = text.trim().replace(/\s+/g, ' ');
	return trimmed.length <= NOTE_CLAMP ? trimmed : trimmed.slice(0, NOTE_CLAMP) + '...';
}

function priorLine(note: PriorNote): string {
	if (note.kind === 'suggestion') {
		return `- [suggested edit] replace "${clamp(note.quote ?? '')}" with "${clamp(note.body)}"`;
	}
	return `- [comment] ${clamp(note.body)}`;
}

export function buildReviewMessage(
	scene: { id: string; title: string | null },
	prior: PriorNote[] = []
): string {
	const title = (scene.title ?? '').trim() || 'this scene';
	const lines = [
		`Review the scene "${title}" (id: ${scene.id}).`,
		'Read it in full with get_scene if you do not already have the text, then leave your feedback through your tools, anchored to the scene:',
		'- leave_comment for an observation about continuity, characterisation, pacing, or clarity; quote the passage you mean.',
		"- suggest_edit for a concrete line edit: replace an exact passage with an improved version, keeping the change minimal and faithful to the author's voice.",
		'Be specific and sparing; a few high-value notes beat many shallow ones. Check the scene against the established world and entity details in your context. Do not rewrite the scene wholesale or change the meaning of the prose.'
	];
	if (prior.length === 0) {
		lines.push(
			'If it is already strong, say so in one brief comment rather than inventing problems.'
		);
	} else {
		lines.push(
			'You have reviewed this scene before and these notes of yours are still open:',
			...prior.map(priorLine),
			'Do not repeat or rephrase them, and do not leave a new note on a passage an open note already covers. Leave only observations that are genuinely new. If a passage you flagged has since been revised and now reads well, you may say so briefly. If you have nothing new to add, leave no notes.'
		);
	}
	return lines.join('\n');
}
