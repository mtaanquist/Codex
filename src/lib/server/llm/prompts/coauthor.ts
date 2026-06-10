// The co-author instruction: write a passage to the writer's brief, grounded in
// the assembled world and current scene (which ride as a system message the
// gateway places after the persona). The result is offered for insert / edit /
// reject; it is never written to the prose on its own.

// Where the writer is in the prose when they ask: a selected passage, or the
// text leading up to the cursor. Lets a brief like "continue from here" land.
export type CoauthorReference = { kind: 'selection' | 'cursor'; text: string };

export const MAX_COAUTHOR_REFERENCE_CHARS = 2000;

export function readCoauthorReference(raw: unknown): CoauthorReference | null {
	if (!raw || typeof raw !== 'object') return null;
	const kind = (raw as { kind?: unknown }).kind;
	const text = (raw as { text?: unknown }).text;
	if (kind !== 'selection' && kind !== 'cursor') return null;
	if (typeof text !== 'string' || !text.trim()) return null;
	return { kind, text: text.trim().slice(0, MAX_COAUTHOR_REFERENCE_CHARS) };
}

export function buildCoauthorMessage(
	instruction: string,
	reference?: CoauthorReference | null
): string {
	const parts: string[] = [];
	if (reference?.kind === 'selection') {
		parts.push('The writer points at this passage of the current scene:', '', reference.text, '');
	} else if (reference?.kind === 'cursor') {
		parts.push(
			'The cursor sits at the end of this passage; continue from here if the brief asks for a continuation:',
			'',
			reference.text,
			''
		);
	}
	parts.push(
		'Write a passage for the current scene to this brief:',
		'',
		`"${instruction.trim()}"`,
		'',
		'Write it as finished prose ready to drop into the manuscript, in the established voice, tense, and point of view, and consistent with the world and characters in your context. Reply with only the passage: no preamble, no commentary, and no surrounding quotation marks.'
	);
	return parts.join('\n');
}
