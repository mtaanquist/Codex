// The co-author instruction: write a passage to the writer's brief, grounded in
// the assembled world and current scene (which ride as a system message the
// gateway places after the persona). The result is offered for insert / edit /
// reject; it is never written to the prose on its own.

import { IN_CONTEXT, PROSE_FORMAT, type WorldSource } from './format.ts';

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

// `rewrite` is for a caller that knows the passage is to be replaced (the
// rewrite prompt an outside app is given); in the app a selection may as well
// be the place to continue from, so the brief decides.
export function buildCoauthorMessage(
	instruction: string,
	reference?: CoauthorReference | null,
	options: { source?: WorldSource; rewrite?: boolean } = {}
): string {
	const source = options.source ?? IN_CONTEXT;
	const rewrite = options.rewrite === true && reference?.kind === 'selection';
	const parts: string[] = [];
	if (rewrite && reference) {
		parts.push('Rewrite this passage of the current scene:', '', reference.text, '');
	} else if (reference?.kind === 'selection') {
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
		rewrite
			? 'Rewrite it to this instruction:'
			: 'Write a passage for the current scene to this brief:',
		'',
		`"${instruction.trim()}"`,
		'',
		`Write it as finished prose ready to ${rewrite ? 'take the place of the passage in' : 'drop into'} the manuscript, in the established voice, tense, and point of view, and consistent with the world and characters ${source.where}. Reply with only the ${rewrite ? 'rewritten passage' : 'passage'}: no preamble, no commentary, and no surrounding quotation marks.`,
		PROSE_FORMAT
	);
	return parts.join('\n');
}
