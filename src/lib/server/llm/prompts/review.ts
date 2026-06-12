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

// What a review run looks for. 'notes' is the default: a few high-value
// observations, right for a draft in motion. The focused passes are
// exhaustive within one category, and 'full' sweeps every category. All of
// them are told not to filter, because a model told to be sparing still
// finds the small mechanical errors and then declines to report them.
export const REVIEW_FOCUSES = ['notes', 'mechanics', 'prose', 'lore', 'full'] as const;
export type ReviewFocus = (typeof REVIEW_FOCUSES)[number];

const CATEGORY_LINES: Record<Exclude<ReviewFocus, 'notes' | 'full'>, string[]> = {
	mechanics: [
		'- Spelling and typos, including doubled or missing words.',
		'- Grammar and punctuation: comma splices, missing question marks on questions, possessives, missing commas around direct address and appositives.',
		'- Word choice and idiom: wrong homophones, malformed idioms, regional spelling consistency (British vs American) against the convention the text uses.'
	],
	prose: [
		'- Prose and flow: filter verbs that hold the reader at a distance, point-of-view epithets where a name or pronoun would read more naturally, dangling modifiers, sentences that trip on a re-read.',
		'- Repetition: words or constructions repeated closely enough to register as a tic.',
		'- Pacing and clarity within the scene.'
	],
	lore: [
		'- Continuity: names, titles, dates, and facts checked against the world and entity details in your context.',
		'- Characterisation: behaviour or voice that contradicts what the context establishes about a character.',
		'- Lore: contradictions with the established world, places, and history in your context.'
	]
};

const FOCUS_INTRO: Record<Exclude<ReviewFocus, 'notes'>, string> = {
	mechanics: 'This is a spelling and grammar pass.',
	prose: 'This is a prose and style pass.',
	lore: 'This is an entities, continuity, and lore pass.',
	full: 'This is a full copyedit pass.'
};

function focusInstruction(focus: Exclude<ReviewFocus, 'notes'>): string {
	const categories =
		focus === 'full'
			? [...CATEGORY_LINES.mechanics, ...CATEGORY_LINES.prose, ...CATEGORY_LINES.lore]
			: CATEGORY_LINES[focus];
	return [
		`${FOCUS_INTRO[focus]} Work through the scene and report every issue you find in the categories below, including small mechanical ones and ones you are uncertain about; do not filter for importance - the writer accepts or rejects each note and would rather discard a nitpick than miss an error. Stay inside these categories:`,
		...categories,
		'Prefer suggest_edit with the corrected text for mechanical fixes, and leave_comment for patterns and observations. Do not rewrite the scene wholesale or change the meaning of the prose.'
	].join('\n');
}

export function buildReviewMessage(
	scene: { id: string; title: string | null },
	prior: PriorNote[] = [],
	focus: ReviewFocus = 'notes'
): string {
	const title = (scene.title ?? '').trim() || 'this scene';
	const lines = [
		`Review the scene "${title}" (id: ${scene.id}).`,
		'Read it in full with get_scene if you do not already have the text, then leave your feedback through your tools, anchored to the scene:',
		'- leave_comment for an observation about continuity, characterisation, pacing, or clarity; quote the passage you mean.',
		"- suggest_edit for a concrete line edit: replace an exact passage with an improved version, keeping the change minimal and faithful to the author's voice.",
		focus === 'notes'
			? 'Be specific and sparing; a few high-value notes beat many shallow ones. Check the scene against the established world and entity details in your context. Do not rewrite the scene wholesale or change the meaning of the prose.'
			: focusInstruction(focus)
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

// The cross-scene pass of a full story review: one run that reads the whole
// story and looks only for issues no single-scene pass can see. Runs after
// the per-scene passes so it does not duplicate their notes.
export function buildConsistencyMessage(sceneList: { id: string; title: string | null }[]): string {
	const listing = sceneList
		.map((scene, i) => `- ${(scene.title ?? '').trim() || `Scene ${i + 1}`} (id: ${scene.id})`)
		.join('\n');
	return [
		'This is the cross-scene consistency pass of a full review. Each scene has already had its own copyedit pass; do not repeat per-scene notes. Read every scene below with get_scene, in order, then report only issues that span scenes:',
		'- Continuity: names, titles, or facts that drift between scenes; timeline arithmetic that does not add up across chapters.',
		'- Lore: contradictions between scenes, or between a scene and the established world context.',
		'- Convention drift: an idiom, spelling convention, or term rendered differently in different scenes.',
		'- Recurring tics: a distinctive word or construction repeated across scenes often enough to register.',
		'Anchor each note with leave_comment on the scene where the issue is clearest, quote the passage, and name the other scene(s) involved so the writer can find both sides. If everything holds together, leave a single brief comment on the first scene saying so.',
		'The scenes, in story order:',
		listing
	].join('\n');
}
