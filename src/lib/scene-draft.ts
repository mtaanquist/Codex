// A scene draft: the Assistant writes one whole scene from the writer's brief,
// staged for the writer to keep or discard. The limits and the wire shapes the
// panel and the server share.

import { MAX_REPLY_TOKENS } from './assistant-tuning.ts';

export const MAX_DRAFT_BRIEF_CHARS = 4000;
export const MAX_DRAFT_POV_CHARS = 200;
// The shortest and longest scene a draft may be asked for, in words.
export const MIN_DRAFT_WORDS = 100;
export const MAX_DRAFT_WORDS = 6000;
// The length offered when the story has no written scene to take one from.
export const FALLBACK_DRAFT_WORDS = 800;
// The offered length follows the story's own scenes, within these bounds.
const MIN_DEFAULT_WORDS = 300;
const MAX_DEFAULT_WORDS = 3000;

// English prose runs a little over a token and a third per word.
const TOKENS_PER_WORD = 1.4;
// Room past the target, so a scene that runs long still ends: a quarter of
// the expected length, and never less than this.
const DRAFT_HEADROOM_TOKENS = 400;
const DRAFT_HEADROOM_SHARE = 4;
// A reply never takes more than this share of a known context window: the
// brief, the world and the neighbouring scenes have to fit beside it.
const WINDOW_SHARE = 2;

export function clampDraftWords(words: number): number {
	if (!Number.isFinite(words)) return FALLBACK_DRAFT_WORDS;
	return Math.min(Math.max(Math.round(words), MIN_DRAFT_WORDS), MAX_DRAFT_WORDS);
}

// The target length offered in the brief form: the median length of the
// story's written scenes, to the nearest fifty words.
export function defaultDraftWords(sceneWordCounts: number[]): number {
	const written = sceneWordCounts.filter((count) => count > 0).sort((a, b) => a - b);
	if (written.length === 0) return FALLBACK_DRAFT_WORDS;
	const mid = Math.floor(written.length / 2);
	const median = written.length % 2 ? written[mid] : (written[mid - 1] + written[mid]) / 2;
	const rounded = Math.round(median / 50) * 50;
	return Math.min(Math.max(rounded, MIN_DEFAULT_WORDS), MAX_DEFAULT_WORDS);
}

// How many tokens a scene of this length is expected to take.
export function draftExpectedTokens(targetWords: number): number {
	return Math.ceil(clampDraftWords(targetWords) * TOKENS_PER_WORD);
}

// How many words fit a reply of this many tokens, for saying where a draft
// would stop.
export function wordsForTokens(tokens: number): number {
	return Math.max(0, Math.floor(tokens / TOKENS_PER_WORD / 50) * 50);
}

// What a draft of this length asks for when nothing holds it back: the
// expected tokens and the headroom.
export function draftWantedTokens(targetWords: number): number {
	const expected = draftExpectedTokens(targetWords);
	return expected + Math.max(DRAFT_HEADROOM_TOKENS, Math.ceil(expected / DRAFT_HEADROOM_SHARE));
}

// A reply or an edit with nothing to read in it: only spaces, line breaks,
// and characters that take no room on the page (zero-width ones, a byte
// order mark).
export function isBlankDraft(text: string): boolean {
	return text.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').trim() === '';
}

// The reply limit a draft of this length asks for: the expected tokens plus
// headroom, held to what the model can return. The app does not know a model's
// own output limit, so the bound is half its context window where that is
// known, and the ceiling a reply length may be set to otherwise.
export function draftMaxTokens(targetWords: number, contextWindow?: number): number {
	const wanted = draftWantedTokens(targetWords);
	const limit = contextWindow
		? Math.min(MAX_REPLY_TOKENS, Math.floor(contextWindow / WINDOW_SHARE))
		: MAX_REPLY_TOKENS;
	return Math.max(1, Math.min(wanted, limit));
}

// What a draft would send and cost, counted without sending it.
export type SceneDraftEstimate = {
	model: string;
	// Prompt tokens: the persona, the world and the neighbouring scenes, and the
	// brief.
	estTokens: number;
	// The most the reply can take: the reply limit the request is sent with,
	// for every scene. The scene's words usually take less, but nothing stops
	// a reply short of its limit, and a model that thinks spends the limit on
	// thinking too. This is the figure priced and held against the spend cap,
	// so the estimate is never lower than what can be charged.
	estCompletionTokens: number;
	// The model may think before it writes (thinking is billed as reply
	// tokens), so the reply is likely to come close to that figure.
	mayThink: boolean;
	// Present only when the model has a price.
	estCostUsd?: number;
	capUsd?: number;
	// False when the model has no price, so a cap that is set cannot be applied.
	capEnforceable: boolean;
	// The spend the writer asked to be warned above.
	warnUsd: number;
	// The estimate is over the spend cap, so the draft is not run.
	overCap: boolean;
	// The reply limit is shorter than the draft needs, so the scene would stop
	// at about this many words.
	limitedToWords?: number;
	// What sets that limit: the reply length the writer set for Write, or the
	// model's context window.
	limitedBy?: 'setting' | 'window';
};

// What to do about an estimate over the spend cap, as the card and the
// server's refusal both say it.
// When the model may think, the estimate is the reply length it is allowed,
// not the scene's, so a shorter scene does not lower it.
export function sceneCapAdvice(mayThink: boolean): string {
	return mayThink
		? 'Lower Longest reply for Write in its Tune window, or raise the cap, both under Account, Assistant.'
		: 'Ask for a shorter scene, or raise the cap under Account, Assistant.';
}
export function chapterCapAdvice(mayThink: boolean): string {
	return mayThink
		? 'Choose fewer scenes, lower Longest reply for Write in its Tune window, or raise the cap. The last two are under Account, Assistant.'
		: 'Choose fewer scenes or a shorter length, or raise the cap under Account, Assistant.';
}

// What an edit or a decision made from an older copy of a draft is told.
export const DRAFT_CHANGED_ELSEWHERE = 'This draft was changed in another window.';

// What a save that would leave a draft blank is told.
export const DRAFT_EMPTY_SAVE = 'An empty draft is not saved. To drop the draft, select Discard.';

// What the brief form opens with.
export type SceneDraftDefaults = {
	brief: string;
	targetWords: number;
	sceneTitle: string | null;
};

// A draft still to be decided, for the list the Assistant tab shows while the
// Assistant is off.
export type WaitingDraft = {
	sceneId: string;
	sceneTitle: string | null;
	status: SceneDraftStatus;
};

export type SceneDraftStatus =
	'pending' | 'running' | 'ready' | 'accepted' | 'discarded' | 'failed';

// A draft as the panel shows it.
export type SceneDraftView = {
	id: string;
	sceneId: string;
	status: SceneDraftStatus;
	brief: string;
	targetWords: number;
	pov: string | null;
	textMd: string;
	// A fingerprint of textMd as stored. The panel sends it back with an edit
	// or a decision, so one made from an older copy (another window) is
	// refused instead of replacing the newer text.
	textVersion: string;
	note: string | null;
	jobId: string | null;
	createdAt: string;
	// Whether the scene had no prose when this was read. Fill is offered only
	// then, and checked again when the writer accepts.
	sceneEmpty: boolean;
	sceneTitle: string | null;
	// The draft is one of a chapter's, written scene by scene by one job.
	inChapterRun: boolean;
};

// How much of the scene drafted just before rides with the next scene's
// request, so the chapter reads on from it.
export const PREVIOUS_DRAFT_CHARS = 6000;

// One scene of a chapter, as the chapter brief form lists it.
export type ChapterDraftScene = {
	sceneId: string;
	title: string | null;
	// The scene's summary, when it has one that still tells the scene.
	brief: string;
	hasText: boolean;
	// It has a draft the writer has not decided, so a chapter draft leaves it out.
	hasDraft: boolean;
};

// What the chapter brief form opens with.
export type ChapterDraftDefaults = {
	chapterTitle: string | null;
	targetWords: number;
	scenes: ChapterDraftScene[];
};

// What a chapter draft would send and cost, summed over its scenes.
export type ChapterDraftEstimate = SceneDraftEstimate & {
	// How many scenes would be drafted.
	scenes: number;
	// Scenes asked for that already have an undecided draft, so are left out.
	skipped: { sceneId: string; title: string | null }[];
};

// The drafts of a chapter's scenes that are being written or waiting for the
// writer, in chapter order.
export type ChapterDraftView = {
	chapterId: string;
	chapterTitle: string | null;
	// The job still writing some of them, when there is one.
	jobId: string | null;
	scenes: {
		draftId: string;
		sceneId: string;
		sceneTitle: string | null;
		status: SceneDraftStatus;
		note: string | null;
	}[];
};

// Where a story page opens a scene's draft: the notice, the activity card and
// the background jobs list all link here.
// draft=show opens the draft the scene has and nothing else, so a link
// followed after the draft was decided does not open a new form.
export function sceneDraftHref(storyId: string, sceneId: string): string {
	return `/stories/${storyId}?scene=${sceneId}&draft=show`;
}

// Where a story page opens a chapter's drafts.
export function chapterDraftHref(storyId: string, chapterId: string): string {
	return `/stories/${storyId}?draftChapter=${chapterId}`;
}
