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
import { bodyExcerpt, estimateTokens } from '../context/assemble.ts';
import { IN_CONTEXT, READ_WITH_TOOLS, type WorldSource } from './format.ts';

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
const categoryLines = (source: WorldSource): Record<ReviewCategory, string[]> => ({
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
		`- Continuity: names, titles, dates, and facts checked against the world and entity details ${source.where}.`,
		`- Characterisation: behaviour or voice that contradicts what ${source.establishes} about a character.`,
		`- Lore: contradictions with the established world, places, and history ${source.where}.`
	]
});

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

function focusInstruction(categories: ReviewCategory[], source: WorldSource): string {
	const all = categoryLines(source);
	const lines = REVIEW_CATEGORIES.filter((c) => categories.includes(c)).flatMap((c) => all[c]);
	return [
		`${passIntro(categories)} Work through the scene and report every issue you find in the categories below, including small mechanical ones and ones you are uncertain about; do not filter for importance - the writer accepts or rejects each note and would rather discard a nitpick than miss an error. Stay inside these categories:`,
		...lines,
		'Prefer suggest_edit with the corrected text for mechanical fixes, and leave_comment for patterns and observations. Do not rewrite the scene wholesale or change the meaning of the prose.'
	].join('\n');
}

// One theme per comment, so each note can be replied to, resolved, and worked
// through on its own. A model told to be sparing otherwise crams a pattern, a
// pacing note, and an overall verdict into one whole-scene comment.
const ONE_THEME_PER_NOTE =
	'Leave one comment per theme. Never combine a recurring pattern, a pacing or structure observation, and an overall impression in one comment; each is its own leave_comment call.';

// How a recurring pattern is handed back. With leave_pattern_note on offer the
// note and its fixes stage together and linked, which the writer then works
// through in order; without it (the minimal tool profile) the note and its
// edits go separately.
const PATTERN_WITH_TOOL =
	'For a recurring pattern (an epithet habit, a pet phrase, filter verbs), use leave_pattern_note: one call with a note opening "Pattern note (<the pattern>):" and an edit for every instance you would change, each with a one-sentence reason specific to that spot. Keep some variety on purpose: leave an instance alone where it helps the rhythm or clarity, and list it under kept with the reason. A pacing or structure observation is not a pattern; use leave_comment for it.';
const PATTERN_WITHOUT_TOOL =
	'When a comment describes a recurring pattern, open it with "Pattern note (<the pattern>):" and give the line edits for it as separate suggest_edit calls, each with a one-sentence reason.';

// sceneTextIncluded says whether the caller put the scene's prose in the
// request already (the scene-local tier survived the budget). A weak model
// re-reads the scene it has been handed unless it is told plainly not to, so
// the instruction is definitive either way, never a hedge.
export function buildReviewMessage(
	scene: { id: string; title: string | null },
	prior: PriorNote[] = [],
	categories: ReviewCategory[] = [],
	sceneTextIncluded = false,
	patternTool = false,
	source: WorldSource = IN_CONTEXT
): string {
	const title = (scene.title ?? '').trim();
	const sparing = categories.length === 0;
	const lines = [
		title
			? `Review the scene "${title}" (id: ${scene.id}).`
			: `Review the scene with id ${scene.id}.`,
		sceneTextIncluded
			? "The scene's full text is already in this message. Do not call get_scene for it. Leave your feedback through your tools, anchored to the scene:"
			: 'Read it in full with get_scene, then leave your feedback through your tools, anchored to the scene:',
		'- leave_comment for an observation about continuity, characterisation, pacing, or clarity; quote the passage you mean.',
		"- suggest_edit for a concrete line edit: replace an exact passage with an improved version, keeping the change minimal and faithful to the author's voice. Give it a one-sentence reason the author can learn from, unless the fix is obvious (a typo, a spelling slip, missing punctuation).",
		ONE_THEME_PER_NOTE,
		patternTool ? PATTERN_WITH_TOOL : PATTERN_WITHOUT_TOOL,
		sparing
			? `Be specific and sparing; a few high-value notes beat many shallow ones. Splitting your observations into one comment per theme does not count against being sparing. Check the scene against the established world and entity details ${source.where}. Do not rewrite the scene wholesale or change the meaning of the prose.`
			: focusInstruction(categories, source)
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
// through the same excerpt helper the recap assembly uses.
function surveyContent(scene: SurveyScene): string {
	const summary = scene.summaryMd?.trim();
	if (summary) return summary;
	if (!scene.bodyMd.trim()) return '(empty)';
	return bodyExcerpt(scene.bodyMd);
}

function surveySceneBlock(scene: SurveyScene, index: number): string {
	const title = (scene.title ?? '').trim() || `Scene ${index + 1}`;
	return `- ${title} (id: ${scene.id}): ${surveyContent(scene)}`;
}

// Split a listing into sequential chunks that each fit the budget, order
// preserved and no overlap. An item that overruns the budget on its own still
// gets its own chunk rather than being dropped.
function splitByBudget<T>(
	items: T[],
	cost: (item: T, index: number) => number,
	budgetTokens: number
): T[][] {
	const chunks: T[][] = [];
	let current: T[] = [];
	let used = 0;
	items.forEach((item, i) => {
		const tokens = cost(item, i);
		if (current.length > 0 && used + tokens > budgetTokens) {
			chunks.push(current);
			current = [];
			used = 0;
		}
		current.push(item);
		used += tokens;
	});
	if (current.length) chunks.push(current);
	return chunks;
}

export function splitSurveyChunks(scenes: SurveyScene[], budgetTokens: number): SurveyScene[][] {
	return splitByBudget(
		scenes,
		(scene, i) => estimateTokens(surveySceneBlock(scene, i)),
		budgetTokens
	);
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

const storySurveyLooksFor = (source: WorldSource = IN_CONTEXT) => [
	'- Continuity: names, titles, or facts that drift between scenes; timeline arithmetic that does not add up.',
	`- Lore: a detail established one way in one scene and differently in another, or against ${source.world}.`,
	'- Character: a trait, relationship, or history that contradicts another scene.'
];

const UNIVERSE_SURVEY_LOOKS_FOR = [
	'- Facts and lore: a detail established one way in one story and differently in another.',
	'- Timeline: dates, ages, or sequences that do not line up between stories.',
	'- Character: a trait, name, title, or history that contradicts another story.',
	'- Place: a location detail rendered inconsistently between stories.'
];

const SPANS_SCENES_ONLY =
	'Judge only what spans scenes; spelling, grammar, and phrasing inside one scene are not this pass.';
// How a contradiction the text bears out is handed back, and what the pass
// leaves alone. Shared by the confirm stage and the brief for an outside agent.
const CONFIRMED_NOTE =
	'If the text bears it out, stage one note: leave_comment on the scene where the contradiction is clearest, quoting the passage and naming the other scene(s) involved so the writer can find both sides. Use suggest_edit instead only when one exact short passage is plainly the wrong side of the contradiction.';
const CONTINUITY_ONLY =
	'Do not leave spelling, grammar, or style notes; this pass is continuity only.';

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
		...(universe ? UNIVERSE_SURVEY_LOOKS_FOR : storySurveyLooksFor()),
		SPANS_SCENES_ONLY,
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
		CONFIRMED_NOTE,
		`If the text does not bear it out, or the two passages can both be true, reply with the single word "discarded" and leave no notes. ${CONTINUITY_ONLY}`,
		'The scenes involved:',
		...scenes.map((scene) => confirmSceneBlock(scene, bodyChars))
	].join('\n');
}

// The whole continuity pass as one brief, for an agent that runs both stages
// itself and reads the material through its tools (an outside app over MCP).
// In the app Codex runs the stages and hands the model the text; the looks-for
// lists and the rules for what to stage are the same sentences.
export function buildContinuityBrief(options: {
	scope: 'story' | 'universe';
	storyId?: string;
}): string {
	const universe = options.scope === 'universe';
	return [
		universe
			? 'Run a continuity pass across every story in this universe, in two stages.'
			: `Run a continuity pass over the story with id ${options.storyId}, in two stages.`,
		universe
			? 'Stage 1, survey. Call list_scenes and go through every scene of every story by its summary (read a scene with get_scene where it has no summary). List for yourself the places where the material contradicts itself across stories:'
			: 'Stage 1, survey. Call list_scenes and go through the scenes of the story in order by their summaries (read a scene with get_scene where it has no summary). List for yourself the places where the material contradicts itself between scenes:',
		...(universe ? UNIVERSE_SURVEY_LOOKS_FOR : storySurveyLooksFor(READ_WITH_TOOLS)),
		SPANS_SCENES_ONLY,
		'Stage 2, confirm. Take one suspected contradiction at a time and read the full text of the scenes involved with get_scene.',
		CONFIRMED_NOTE,
		`If the text does not bear it out, or the two passages can both be true, drop it and leave no note. ${CONTINUITY_ONLY}`
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
function parseArrayFrom<T>(
	reply: string,
	start: number,
	shape: (parsed: unknown[]) => T[]
): { items: T[]; end: number } | null {
	for (let end = reply.lastIndexOf(']'); end > start; end = reply.lastIndexOf(']', end - 1)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(reply.slice(start, end + 1));
		} catch {
			continue;
		}
		if (!Array.isArray(parsed)) return null;
		return { items: shape(parsed), end };
	}
	return null;
}

// How many opening brackets are worth trying. A reply that leads with prose has
// a handful at most; past that the reply is not the JSON array it was asked for
// and the retry turn is the right answer.
const MAX_ARRAY_STARTS = 20;

// A JSON array reply, read leniently: the adapters have no structured-output
// mode, so the model is asked for a bare JSON array and often obliges with a
// code fence or a sentence around it. Every '[' is tried as an array start and
// the best result wins: the most usable entries, earliest on a tie. Anchoring
// on the first '[' alone was wrong twice over - a bracket in the prose ahead of
// the JSON burned the retry, and a reply opening with a stray '[]' parsed
// cleanly and reported nothing at all. An empty array is still a valid answer
// ("nothing found"), so it wins only when nothing else parsed. Null means
// nothing parsed, which the caller retries once with a corrective turn.
function parseLenientArray<T>(reply: string, shape: (parsed: unknown[]) => T[]): T[] | null {
	let best: T[] | null = null;
	let starts = 0;
	for (let start = reply.indexOf('['); start !== -1; start = reply.indexOf('[', start + 1)) {
		if (starts >= MAX_ARRAY_STARTS) break;
		starts += 1;
		const found = parseArrayFrom(reply, start, shape);
		if (!found) continue;
		if (!best || found.items.length > best.length) best = found.items;
		// Brackets inside an array that already parsed are its own nested values,
		// not competing entries; skip past them.
		start = found.end;
	}
	return best;
}

export function parseCandidates(reply: string): ContinuityCandidate[] | null {
	return parseLenientArray(reply, shapeCandidates);
}

// The corrective turn after an unparseable survey reply.
export const SURVEY_RETRY_MESSAGE =
	'That reply could not be read. Send the same findings again as a JSON array and nothing else: no prose, no code fence. Each entry is {"sceneIds": ["..."], "claim": "..."}. Reply with [] if you found nothing.';

// The re-read after the writer accepts one fix from a pattern note: the changed
// paragraph and its neighbours, the note it came from, and a brief to check how
// the passage reads now, the way an editor rereads after a change. At most one
// follow-up edit, inside the passage shown.
export function buildRereadMessage(input: {
	sceneId: string;
	sceneTitle: string | null;
	passage: string;
	changed: string;
	note: string;
}): string {
	const title = (input.sceneTitle ?? '').trim() || 'this scene';
	const changed = input.changed.trim()
		? `The writer just accepted this change, which now reads: "${input.changed.trim()}".`
		: 'The writer just accepted a change that removed some text here.';
	return [
		`You are re-reading a passage of the scene "${title}" (id: ${input.sceneId}) after a fix from one of your pattern notes was accepted.`,
		changed,
		'The pattern note it came from:',
		input.note
			.trim()
			.split('\n')
			.map((line) => `> ${line}`)
			.join('\n'),
		'Read the passage below as it stands now and check how it reads after the change: a pronoun that has become ambiguous (two people it could mean), the same name repeated too close together, or a rhythm that now trips. Keeping some variety is fine; do not undo the pattern fix or chase every remaining instance.',
		'If something now reads badly, stage exactly one suggest_edit inside this passage that fixes it, with a one-sentence reason. If it reads well, reply with the single word "fine" and stage nothing. The passage is all you need; do not call any other tool.',
		'The passage:',
		input.passage
	].join('\n');
}

// ---- the pattern pass (chapter-wide and whole-book) ----
//
// Habits in the prose such as POV epithets, a pet phrase, or filter verbs
// usually first show across a chapter, where each scene alone holds only one or
// two instances. The pass runs in two stages, like the continuity pass: a
// survey over the full prose of the chapter (or the whole book) asks for
// recurring patterns as JSON, with no tools; then an apply stage takes one
// pattern and one scene at a time and stages a linked suggest_edit for each
// instance it would change.

// The most patterns one unit reports: a chapter, and the whole book.
export const CHAPTER_PATTERN_CAP = 5;
export const BOOK_PATTERN_CAP = 8;

export type PatternScene = {
	id: string;
	title: string | null;
	bodyMd: string;
	// The chapter heading, for the whole-book listing.
	chapterTitle?: string;
};

// A pattern the survey found.
export type FoundPattern = {
	name: string;
	description: string;
	sceneIds: string[];
	examples: string[];
};

function patternSceneBlock(scene: PatternScene): string {
	const title = (scene.title ?? '').trim() || 'Untitled scene';
	return `### ${title} (id: ${scene.id})\n${scene.bodyMd.trim() || '(empty)'}`;
}

// The listing, with a chapter heading wherever the chapter changes (the
// whole-book survey); a chapter survey has no headings.
function patternListing(scenes: PatternScene[]): string {
	const out: string[] = [];
	let chapter: string | undefined;
	for (const scene of scenes) {
		if (scene.chapterTitle !== undefined && scene.chapterTitle !== chapter) {
			chapter = scene.chapterTitle;
			out.push(`## ${chapter}`);
		}
		out.push(patternSceneBlock(scene));
	}
	return out.join('\n\n');
}

export function patternListingTokens(scenes: PatternScene[]): number {
	return estimateTokens(patternListing(scenes));
}

export function splitPatternChunks(scenes: PatternScene[], budgetTokens: number): PatternScene[][] {
	return splitByBudget(scenes, (scene) => estimateTokens(patternSceneBlock(scene)), budgetTokens);
}

// What the survey looks for. Kept to habits that repeat; a one-off fix is the
// scene review's job.
const PATTERN_LOOKS_FOR = [
	'- Point-of-view epithets: a character called by a descriptor ("the elf", "the older man") where the name or a pronoun would read more naturally.',
	'- A pet word or phrase that recurs often enough to register.',
	'- Filter verbs (saw, heard, felt, noticed) that keep the reader at a distance.',
	'- A sentence shape or opening repeated as a tic, or a character gesture used again and again.'
];

export const PATTERN_FORMAT = [
	'Reply with a JSON array and nothing else: no prose before or after it, no code fence, no explanation.',
	'[{"name": "a short name", "description": "one or two sentences on the pattern and why it matters", "sceneIds": ["the ids of the scenes where it shows"], "examples": ["short exact quotes of instances"]}]',
	'Name each scene by the exact id given below. Do not stage notes and do not call tools; a later stage goes through each scene and proposes the fixes. If you see no recurring pattern, reply with [].'
];

const patternReportRule = (cap: number) =>
	`Report only patterns with several instances, not one-off fixes, spelling, or grammar. Report at most ${cap}, the ones that matter most.`;

export type KnownPattern = { name: string; description: string };

export function buildPatternSurveyMessage(
	scenes: PatternScene[],
	options: {
		scope: 'chapter' | 'book';
		cap: number;
		chunk?: SurveyChunk;
		// Patterns found in earlier chapters (the whole-book pass going chapter
		// by chapter), reported again under the same name when they show here.
		known?: KnownPattern[];
		// Patterns that already have an open note, not to be reported again.
		open?: string[];
	}
): string {
	const book = options.scope === 'book';
	const lines = [
		book
			? 'This is the survey stage of a whole-book pattern pass. Below is the full text of the book, chapter by chapter. Find the habits in the prose that recur across it:'
			: 'This is the survey stage of a chapter pattern pass. Below is the full text of the chapter, scene by scene. Find the habits in the prose that recur across it:',
		...PATTERN_LOOKS_FOR,
		patternReportRule(options.cap),
		...PATTERN_FORMAT
	];
	if (options.known?.length) {
		lines.push(
			'Patterns found so far in earlier chapters. If one shows here too, report it again under exactly the same name with the ids and examples from this part; also report any new ones:',
			...options.known.map((p) => `- ${clamp(p.name)}: ${clamp(p.description)}`)
		);
	}
	if (options.open?.length) {
		lines.push(
			'These patterns already have open notes. Do not report them again:',
			...options.open.map((name) => `- ${clamp(name)}`)
		);
	}
	if (options.chunk) {
		lines.push(
			`This is part ${options.chunk.index} of ${options.chunk.total} of the text; the other parts are surveyed separately.`
		);
	}
	lines.push('The text:', patternListing(scenes));
	return lines.join('\n');
}

// The pattern pass as one brief, for an agent that reads the chapter through
// its tools and stages the notes itself (an outside app over MCP). cap is the
// most patterns to report per chapter.
export function buildPatternBrief(options: {
	storyId: string;
	chapter?: string;
	cap: number;
}): string {
	const chapter = options.chapter?.trim();
	return [
		chapter
			? `Run a pattern pass over the chapter "${chapter}" of the story with id ${options.storyId}.`
			: `Run a pattern pass over the story with id ${options.storyId}, one chapter at a time.`,
		'Find the scenes with list_scenes and read each one in full with get_scene. Find the habits in the prose that recur across the chapter:',
		...PATTERN_LOOKS_FOR,
		patternReportRule(options.cap),
		PATTERN_WITH_TOOL,
		'One leave_pattern_note call carries the edits of one scene: make it on the first scene where the pattern shows. For the same pattern in another scene, stage each fix with suggest_edit and pass the id of the note as patternNoteId, so the writer goes through every fix from the one note.'
	].join('\n');
}

const MAX_PATTERN_EXAMPLES = 6;
// Keeps a pattern's note well inside the comment length limit.
const PATTERN_DESCRIPTION_CHARS = 600;
const PATTERN_EXAMPLE_CHARS = 200;
const PATTERN_PLACES = 20;
const PATTERN_NAME_CHARS = 80;
const cut = (text: string, max: number) =>
	text.length <= max ? text : text.slice(0, max).trimEnd() + '...';

function shapePatterns(parsed: unknown[]): FoundPattern[] {
	return parsed.flatMap((entry) => {
		if (!entry || typeof entry !== 'object') return [];
		const { name, description, sceneIds, examples } = entry as Record<string, unknown>;
		if (typeof name !== 'string' || !name.replace(/[()]/g, '').trim()) return [];
		if (!Array.isArray(sceneIds)) return [];
		const ids = sceneIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
		if (!ids.length) return [];
		return [
			{
				// A short name with no brackets: it goes in the note's "(name)".
				name: cut(name.replace(/[()]/g, '').trim(), PATTERN_NAME_CHARS),
				description:
					typeof description === 'string' ? cut(description.trim(), PATTERN_DESCRIPTION_CHARS) : '',
				sceneIds: [...new Set(ids)],
				examples: Array.isArray(examples)
					? examples
							.filter((e): e is string => typeof e === 'string' && e.trim().length > 0)
							.map((e) => cut(e.trim(), PATTERN_EXAMPLE_CHARS))
							.slice(0, MAX_PATTERN_EXAMPLES)
					: []
			}
		];
	});
}

export function parsePatterns(reply: string): FoundPattern[] | null {
	return parseLenientArray(reply, shapePatterns);
}

const patternKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ');

// Patterns from several survey replies (chunks, or chapters of the book) as one
// list: the same name (ignoring case and spacing) is one pattern, its scenes and
// examples joined in the order they came, its first description kept.
export function mergePatterns(lists: FoundPattern[][]): FoundPattern[] {
	const merged = new Map<string, FoundPattern>();
	for (const pattern of lists.flat()) {
		const key = patternKey(pattern.name);
		const existing = merged.get(key);
		if (!existing) {
			merged.set(key, {
				...pattern,
				sceneIds: [...pattern.sceneIds],
				examples: [...pattern.examples]
			});
			continue;
		}
		if (!existing.description) existing.description = pattern.description;
		for (const id of pattern.sceneIds)
			if (!existing.sceneIds.includes(id)) existing.sceneIds.push(id);
		for (const example of pattern.examples) {
			if (existing.examples.length >= MAX_PATTERN_EXAMPLES) break;
			if (!existing.examples.includes(example)) existing.examples.push(example);
		}
	}
	return [...merged.values()];
}

export const PATTERN_RETRY_MESSAGE =
	'That reply could not be read. Send the same patterns again as a JSON array and nothing else: no prose, no code fence. Each entry is {"name": "...", "description": "...", "sceneIds": ["..."], "examples": ["..."]}. Reply with [] if you found none.';

// The note a pattern leaves, on the first scene where it shows: what it is,
// and where else it turns up so the writer can find every side of it.
export function patternNoteBody(
	pattern: FoundPattern,
	where: { label: string; places: string[] }
): string {
	const description = pattern.description || 'A habit that recurs in the prose.';
	const lines = [`Pattern note (${pattern.name}): ${description}`];
	if (pattern.examples.length) {
		lines.push('', `For example: ${pattern.examples.map((e) => `"${e}"`).join(', ')}.`);
	}
	if (where.places.length > 1) {
		const shown = where.places.slice(0, PATTERN_PLACES);
		const more = where.places.length - shown.length;
		lines.push('', `${where.label}: ${shown.join(', ')}${more > 0 ? `, and ${more} more` : ''}.`);
	}
	return lines.join('\n');
}

// Stage B: one pattern and one scene's full text. Only suggest_edit is
// offered, and every edit it stages is linked to the pattern's note.
export function buildPatternApplyMessage(
	pattern: FoundPattern,
	scene: PatternScene,
	bodyChars: number
): string {
	const body = scene.bodyMd.trim();
	const text =
		body.length <= bodyChars
			? body
			: body.slice(0, bodyChars).trimEnd() + '\n[... the rest of this scene is cut to fit]';
	const lines = [
		'This is the apply stage of a pattern pass. A survey of the prose found this pattern:',
		`${pattern.name}: ${pattern.description || 'a habit that recurs in the prose.'}`
	];
	if (pattern.examples.length) {
		lines.push(`Instances it noted: ${pattern.examples.map((e) => `"${e}"`).join(', ')}.`);
	}
	lines.push(
		"Below is the full text of one scene where it shows; it is all you need, so do not call get_scene. Stage a suggest_edit for each instance in this scene that you would change, keeping each change minimal and in the author's voice, with a one-sentence reason. Keep some variety on purpose: leave an instance alone where it helps the rhythm or clarity. Change nothing else.",
		'If no instance in this scene needs changing, reply with the single word "none" and stage nothing.',
		patternSceneBlock({ ...scene, bodyMd: text })
	);
	return lines.join('\n');
}
