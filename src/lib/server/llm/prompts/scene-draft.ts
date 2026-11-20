// The scene draft instruction: write one whole scene to the writer's brief,
// grounded in the assembled world and the scenes around it (which ride as a
// system message the gateway places after the persona). The result is staged
// for the writer to keep or discard; it is never written to a scene on its own.

import { PROSE_FORMAT } from './format.ts';

export type SceneDraftBrief = {
	brief: string;
	targetWords: number;
	// Whose point of view to write from, in the writer's words; empty leaves it
	// to the established voice.
	pov?: string | null;
	// The prose the scene already holds, or its closing part when it is long.
	// The draft carries on from it instead of starting over.
	existingProse?: string | null;
	// The scene that comes next, so this one ends where that one can begin:
	// its summary when it has a current one, else how it opens.
	following?: { title: string | null; text: string; kind: 'summary' | 'opening' } | null;
};

export function buildSceneDraftMessage(input: SceneDraftBrief): string {
	const parts: string[] = [];
	const existing = input.existingProse?.trim();
	if (existing) {
		parts.push(
			'The current scene already has this prose, written by the writer:',
			'',
			existing,
			'',
			'Write the rest of the scene from exactly where it stops. Do not repeat or rewrite what is already there.',
			''
		);
	}
	const following = input.following?.text.trim();
	if (following) {
		const title = input.following?.title?.trim();
		parts.push(
			`The scene that follows this one${title ? ` ("${title}")` : ''} ${
				input.following?.kind === 'summary' ? 'is summarised as' : 'opens with'
			}:`,
			'',
			following,
			'',
			'End this scene so that one can follow it. Do not write the following scene.',
			''
		);
	}
	parts.push(
		existing
			? 'Write the rest of the current scene to this brief:'
			: 'Write the whole of the current scene to this brief:',
		'',
		`"${input.brief.trim()}"`,
		''
	);
	const pov = input.pov?.trim();
	if (pov) parts.push(`Point of view: ${pov}.`);
	parts.push(
		`Aim for about ${input.targetWords} words, and bring the scene to an end within that length.`,
		'',
		'Write it as finished prose ready to drop into the manuscript, in the established voice and tense' +
			(pov ? '' : ', and point of view') +
			', and consistent with the world, the characters, and the scenes around it in your context. Reply with only the scene: no title, no preamble, no commentary, and no surrounding quotation marks.',
		PROSE_FORMAT
	);
	return parts.join('\n');
}
