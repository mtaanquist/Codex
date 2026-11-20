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
	// its summary when it has a current one, else how it opens. In a chapter
	// draft, the writer's plan for it when it is drafted next.
	following?: {
		title: string | null;
		text: string;
		kind: 'summary' | 'opening' | 'plan';
	} | null;
	// A chapter draft: what the writer said about the chapter as a whole.
	chapterBrief?: string | null;
	// A chapter draft: the scene drafted just before this one (or its closing
	// part). It is not in the manuscript yet, so the context does not hold it.
	previousDraft?: string | null;
};

const FOLLOWING_LEAD = {
	summary: 'is summarised as',
	opening: 'opens with',
	plan: 'is planned as'
} as const;

export function buildSceneDraftMessage(input: SceneDraftBrief): string {
	const parts: string[] = [];
	const chapter = input.chapterBrief?.trim();
	if (chapter) {
		parts.push(
			'This scene is one of a chapter being drafted scene by scene. The writer describes the chapter as:',
			'',
			`"${chapter}"`,
			''
		);
	}
	const previous = input.previousDraft?.trim();
	if (previous) {
		parts.push(
			'The scene before this one was just drafted, and reads:',
			'',
			previous,
			'',
			'Carry on from where it ends. Do not repeat it.',
			''
		);
	}
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
				FOLLOWING_LEAD[input.following?.kind ?? 'opening']
			}:`,
			'',
			following,
			'',
			'End this scene so that one can follow it. Do not write the following scene.',
			''
		);
	}
	const brief = input.brief.trim();
	if (brief) {
		parts.push(
			existing
				? 'Write the rest of the current scene to this brief:'
				: 'Write the whole of the current scene to this brief:',
			'',
			`"${brief}"`,
			''
		);
	} else {
		// Only a chapter draft sends a scene without a brief of its own.
		parts.push(
			existing
				? 'Write the rest of the current scene, as its part of the chapter described above.'
				: 'Write the whole of the current scene, as its part of the chapter described above.',
			''
		);
	}
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
