// The co-author instruction: write a passage to the writer's brief, grounded in
// the assembled world and current scene (which ride as a system message the
// gateway places after the persona). The result is offered for insert / edit /
// reject; it is never written to the prose on its own.

export function buildCoauthorMessage(instruction: string): string {
	return [
		'Write a passage for the current scene to this brief:',
		'',
		`"${instruction.trim()}"`,
		'',
		'Write it as finished prose ready to drop into the manuscript, in the established voice, tense, and point of view, and consistent with the world and characters in your context. Reply with only the passage: no preamble, no commentary, and no surrounding quotation marks.'
	].join('\n');
}
