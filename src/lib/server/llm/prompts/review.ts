// The reviewer instruction for a single-scene Assistant review. The gateway
// prepends the persona system message and the surface adds the assembled world
// context; this is the task turn that tells the Assistant to review one scene
// and leave its feedback through the staging tools (suggest_edit, leave_comment)
// rather than rewriting the prose. Shipped-fixed in v1 (see assistant.md).

export function buildReviewMessage(scene: { id: string; title: string | null }): string {
	const title = (scene.title ?? '').trim() || 'this scene';
	return [
		`Review the scene "${title}" (id: ${scene.id}).`,
		'Read it in full with get_scene if you do not already have the text, then leave your feedback through your tools, anchored to the scene:',
		'- leave_comment for an observation about continuity, characterisation, pacing, or clarity; quote the passage you mean.',
		"- suggest_edit for a concrete line edit: replace an exact passage with an improved version, keeping the change minimal and faithful to the author's voice.",
		'Be specific and sparing; a few high-value notes beat many shallow ones. Check the scene against the established world and entity details in your context. If it is already strong, say so in one brief comment rather than inventing problems. Do not rewrite the scene wholesale or change the meaning of the prose.'
	].join('\n');
}
