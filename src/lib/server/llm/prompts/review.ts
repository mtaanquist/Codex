// The reviewer instruction for a single-scene Assistant review. The gateway
// prepends the persona system message and the surface adds the assembled world
// context; this is the task turn that tells the Assistant to review one scene
// and leave its feedback through the staging tools (suggest_edit, leave_comment)
// rather than rewriting the prose. Shipped-fixed in v1 (see assistant.md).

import {
	CATEGORY_LABELS,
	isFullReview,
	REVIEW_CATEGORIES,
	type ReviewCategory
} from '../../../review-shape.ts';
import { estimateTokens } from '../context/assemble.ts';

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

// What a review run looks for. An empty category set is the default: a few
// high-value observations, right for a draft in motion. A non-empty set is an
// exhaustive pass over exactly those categories, and all three together is the
// full copyedit. The exhaustive passes are told not to filter, because a model
// told to be sparing still finds the small mechanical errors and then declines
// to report them.
const CATEGORY_LINES: Record<ReviewCategory, string[]> = {
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

// The intro sentence for an exhaustive pass: a fixed line for the full copyedit,
// otherwise the selected category labels joined into one phrase.
function passIntro(categories: ReviewCategory[]): string {
	if (isFullReview(categories)) return 'This is a full copyedit pass.';
	const labels = REVIEW_CATEGORIES.filter((c) => categories.includes(c)).map(
		(c) => CATEGORY_LABELS[c]
	);
	const phrase =
		labels.length <= 1
			? labels[0]
			: `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
	return `This is a ${phrase} pass.`;
}

function focusInstruction(categories: ReviewCategory[]): string {
	const lines = REVIEW_CATEGORIES.filter((c) => categories.includes(c)).flatMap(
		(c) => CATEGORY_LINES[c]
	);
	return [
		`${passIntro(categories)} Work through the scene and report every issue you find in the categories below, including small mechanical ones and ones you are uncertain about; do not filter for importance - the writer accepts or rejects each note and would rather discard a nitpick than miss an error. Stay inside these categories:`,
		...lines,
		'Prefer suggest_edit with the corrected text for mechanical fixes, and leave_comment for patterns and observations. Do not rewrite the scene wholesale or change the meaning of the prose.'
	].join('\n');
}

// sceneTextIncluded says whether the caller put the scene's prose in the
// request already (the scene-local tier survived the budget). A weak model
// re-reads the scene it has been handed unless it is told plainly not to, so
// the instruction is definitive either way, never a hedge.
export function buildReviewMessage(
	scene: { id: string; title: string | null },
	prior: PriorNote[] = [],
	categories: ReviewCategory[] = [],
	sceneTextIncluded = false
): string {
	const title = (scene.title ?? '').trim() || 'this scene';
	const sparing = categories.length === 0;
	const lines = [
		`Review the scene "${title}" (id: ${scene.id}).`,
		sceneTextIncluded
			? "The scene's full text is already in this message. Do not call get_scene for it. Leave your feedback through your tools, anchored to the scene:"
			: 'Read it in full with get_scene, then leave your feedback through your tools, anchored to the scene:',
		'- leave_comment for an observation about continuity, characterisation, pacing, or clarity; quote the passage you mean.',
		"- suggest_edit for a concrete line edit: replace an exact passage with an improved version, keeping the change minimal and faithful to the author's voice.",
		sparing
			? 'Be specific and sparing; a few high-value notes beat many shallow ones. Check the scene against the established world and entity details in your context. Do not rewrite the scene wholesale or change the meaning of the prose.'
			: focusInstruction(categories)
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

// The cross-scene continuity pass runs in two stages, and the three builders
// below are its prompts (see scene-review.ts for the run).
//
// Stage A (survey) hands the model the scene summaries in story order and asks
// for candidate contradictions as JSON. No tools, no prose bodies: a whole story
// of summaries fits a small context window where a whole story of prose does
// not, and the old single pass silently compared only what survived the
// overflow. Stage B (confirm) then takes one candidate at a time with the full
// text of the named scenes, and stages a note only if the contradiction is real.

// A scene as the survey sees it: enough to judge whether two scenes disagree,
// never the whole body. storyTitle is set on the universe pass, where scenes
// from several stories are listed together.
export type SurveyScene = {
	id: string;
	title: string | null;
	summaryMd: string | null;
	bodyMd: string;
	storyTitle?: string;
};

// Where a scene has no summary yet (summaries are sparse until summary
// maintenance fills them), the survey falls back to the opening of its body,
// the same way the recap assembly does.
const SURVEY_BODY_EXCERPT_CHARS = 1500;

function surveyContent(scene: SurveyScene): string {
	const summary = scene.summaryMd?.trim();
	if (summary) return summary;
	const body = scene.bodyMd.trim();
	if (!body) return '(empty)';
	if (body.length <= SURVEY_BODY_EXCERPT_CHARS) return body;
	return body.slice(0, SURVEY_BODY_EXCERPT_CHARS).trimEnd() + ' [...]';
}

function surveySceneBlock(scene: SurveyScene, index: number): string {
	const title = (scene.title ?? '').trim() || `Scene ${index + 1}`;
	return `- ${title} (id: ${scene.id}): ${surveyContent(scene)}`;
}

// Split the listing into sequential chunks that each fit the budget, story
// order preserved and no overlap. A single scene that overruns the budget on
// its own still gets its own chunk rather than being dropped.
export function splitSurveyChunks(scenes: SurveyScene[], budgetTokens: number): SurveyScene[][] {
	const chunks: SurveyScene[][] = [];
	let current: SurveyScene[] = [];
	let used = 0;
	scenes.forEach((scene, i) => {
		const cost = estimateTokens(surveySceneBlock(scene, i));
		if (current.length > 0 && used + cost > budgetTokens) {
			chunks.push(current);
			current = [];
			used = 0;
		}
		current.push(scene);
		used += cost;
	});
	if (current.length) chunks.push(current);
	return chunks;
}

// Consecutive scenes of the same story, for the universe listing.
function groupByStory(scenes: SurveyScene[]): { storyTitle: string; scenes: SurveyScene[] }[] {
	const groups: { storyTitle: string; scenes: SurveyScene[] }[] = [];
	for (const scene of scenes) {
		const storyTitle = (scene.storyTitle ?? '').trim() || 'Untitled story';
		const last = groups[groups.length - 1];
		if (last && last.storyTitle === storyTitle) last.scenes.push(scene);
		else groups.push({ storyTitle, scenes: [scene] });
	}
	return groups;
}

const SURVEY_FORMAT = [
	'Reply with a JSON array and nothing else: no prose before or after it, no code fence, no explanation.',
	'[{"sceneIds": ["the ids of the scenes involved"], "claim": "one line naming what contradicts what"}]',
	'One entry per suspected contradiction, each naming at least two scenes by the exact ids below. Keep the claim to one line. Do not stage notes and do not call tools; a later stage reads the full text of the scenes you name and discards whatever the prose does not bear out. If you see nothing, reply with [].'
];

const STORY_SURVEY_LOOKS_FOR = [
	'- Continuity: names, titles, or facts that drift between scenes; timeline arithmetic that does not add up.',
	'- Lore: a detail established one way in one scene and differently in another, or against the world context.',
	'- Character: a trait, relationship, or history that contradicts another scene.'
];

const UNIVERSE_SURVEY_LOOKS_FOR = [
	'- Facts and lore: a detail established one way in one story and differently in another.',
	'- Timeline: dates, ages, or sequences that do not line up between stories.',
	'- Character: a trait, name, title, or history that contradicts another story.',
	'- Place: a location detail rendered inconsistently between stories.'
];

export type SurveyChunk = { index: number; total: number };

// Stage A: the scene summaries in order, and the ask for candidate
// contradictions as JSON. chunk is set when the listing was split, so the model
// knows it is looking at part of the material and does not read the gaps as
// contradictions.
export function buildSurveyMessage(
	scenes: SurveyScene[],
	options: { scope: 'story' | 'universe'; chunk?: SurveyChunk }
): string {
	const universe = options.scope === 'universe';
	const listing = universe
		? groupByStory(scenes)
				.map((group) =>
					[
						`Story: ${group.storyTitle}`,
						...group.scenes.map((scene, i) => `  ${surveySceneBlock(scene, i)}`)
					].join('\n')
				)
				.join('\n')
		: scenes.map((scene, i) => surveySceneBlock(scene, i)).join('\n');
	const lines = [
		universe
			? 'This is the survey stage of a universe-wide continuity pass. Below is every scene of every story in this universe, each with its summary or the opening of its text. Name the places where the material contradicts itself across stories:'
			: 'This is the survey stage of the cross-scene continuity pass. Below are the scenes of the story in order, each with its summary or the opening of its text. Name the places where the material contradicts itself between scenes:',
		...(universe ? UNIVERSE_SURVEY_LOOKS_FOR : STORY_SURVEY_LOOKS_FOR),
		'Judge only what spans scenes; spelling, grammar, and phrasing inside one scene are not this pass.',
		...SURVEY_FORMAT
	];
	if (options.chunk) {
		lines.push(
			`This is part ${options.chunk.index} of ${options.chunk.total} of the material; the other parts are surveyed separately, so do not treat what is missing here as a gap in the story.`
		);
	}
	lines.push(
		universe ? 'The stories and their scenes, in order:' : 'The scenes, in story order:',
		listing
	);
	return lines.join('\n');
}

// A scene as the confirm stage sees it: the full text, capped so a pair of long
// scenes still fits the window.
export type ConfirmScene = {
	id: string;
	title: string | null;
	bodyMd: string;
	storyTitle?: string;
};

function confirmSceneBlock(scene: ConfirmScene, bodyChars: number): string {
	const title = (scene.title ?? '').trim() || 'Untitled';
	const story = scene.storyTitle?.trim() ? ` [story: ${scene.storyTitle.trim()}]` : '';
	const body = scene.bodyMd.trim();
	let text: string;
	if (!body) text = '(empty)';
	else if (body.length <= bodyChars) text = body;
	else text = body.slice(0, bodyChars).trimEnd() + '\n[... the rest of this scene is cut to fit]';
	return `### ${title} (id: ${scene.id})${story}\n${text}`;
}

// Stage B: one candidate contradiction and the full text of the scenes it
// names. The bodies ride in the message, so the model has no reason to read
// them again through the tools.
export function buildConfirmMessage(
	claim: string,
	scenes: ConfirmScene[],
	bodyChars: number
): string {
	return [
		'This is the confirm stage of the continuity pass. A survey of the scene summaries flagged a possible contradiction; check it against the full text below, which is all you need (do not call get_scene).',
		`Suspected contradiction: ${claim.trim()}`,
		'If the text bears it out, stage one note: leave_comment on the scene where the contradiction is clearest, quoting the passage and naming the other scene(s) involved so the writer can find both sides. Use suggest_edit instead only when one exact short passage is plainly the wrong side of the contradiction.',
		'If the text does not bear it out, or the two passages can both be true, reply with the single word "discarded" and leave no notes. Do not leave spelling, grammar, or style notes; this pass is continuity only.',
		'The scenes involved:',
		...scenes.map((scene) => confirmSceneBlock(scene, bodyChars))
	].join('\n');
}

// A candidate contradiction from the survey stage.
export type ContinuityCandidate = { sceneIds: string[]; claim: string };

// Keep the entries of a parsed array that carry both fields.
function shapeCandidates(parsed: unknown[]): ContinuityCandidate[] {
	return parsed.flatMap((entry) => {
		if (!entry || typeof entry !== 'object') return [];
		const { sceneIds, claim } = entry as { sceneIds?: unknown; claim?: unknown };
		if (typeof claim !== 'string' || !claim.trim()) return [];
		if (!Array.isArray(sceneIds)) return [];
		const ids = sceneIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
		if (!ids.length) return [];
		return [{ sceneIds: ids, claim: claim.trim() }];
	});
}

// The longest array that parses from this '[', found by walking the closing
// brackets from the end of the reply back: the outermost close that parses is
// the whole array, and anything after it is prose.
function parseArrayFrom(
	reply: string,
	start: number
): { candidates: ContinuityCandidate[]; end: number } | null {
	for (let end = reply.lastIndexOf(']'); end > start; end = reply.lastIndexOf(']', end - 1)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(reply.slice(start, end + 1));
		} catch {
			continue;
		}
		if (!Array.isArray(parsed)) return null;
		return { candidates: shapeCandidates(parsed), end };
	}
	return null;
}

// How many opening brackets are worth trying. A reply that leads with prose has
// a handful at most; past that the reply is not the JSON array it was asked for
// and the retry turn is the right answer.
const MAX_ARRAY_STARTS = 20;

// The survey reply, read leniently: the adapters have no structured-output
// mode, so the model is asked for a bare JSON array and often obliges with a
// code fence or a sentence around it. Every '[' is tried as an array start and
// the best result wins: the most findings, earliest on a tie. Anchoring on the
// first '[' alone was wrong twice over - a bracket in the prose ahead of the
// JSON burned the retry, and a reply opening with a stray '[]' parsed cleanly
// and reported no contradictions at all. An empty array is still a valid answer
// ("nothing found"), so it wins only when nothing else parsed. Null means
// nothing parsed, which the caller retries once with a corrective turn.
export function parseCandidates(reply: string): ContinuityCandidate[] | null {
	let best: ContinuityCandidate[] | null = null;
	let starts = 0;
	for (let start = reply.indexOf('['); start !== -1; start = reply.indexOf('[', start + 1)) {
		if (starts >= MAX_ARRAY_STARTS) break;
		starts += 1;
		const found = parseArrayFrom(reply, start);
		if (!found) continue;
		if (!best || found.candidates.length > best.length) best = found.candidates;
		// Brackets inside an array that already parsed are its own nested values,
		// not competing candidates; skip past them.
		start = found.end;
	}
	return best;
}

// The corrective turn after an unparseable survey reply.
export const SURVEY_RETRY_MESSAGE =
	'That reply could not be read. Send the same findings again as a JSON array and nothing else: no prose, no code fence. Each entry is {"sceneIds": ["..."], "claim": "..."}. Reply with [] if you found nothing.';
