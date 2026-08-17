import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../auth.ts';
import {
	reviewComments,
	reviewSuggestions,
	reviewThreads,
	revisions,
	scenes,
	stories
} from '../db/schema.ts';
import {
	assembleContext,
	assembleSceneDelta,
	assembleStoryFrame,
	buildSystemMessage,
	type AssembledContext
} from './context/assemble.ts';
import {
	buildConfirmMessage,
	buildReviewMessage,
	buildSurveyMessage,
	parseCandidates,
	splitSurveyChunks,
	SURVEY_RETRY_MESSAGE,
	type ContinuityCandidate,
	type PriorNote,
	type SurveyScene
} from './prompts/review.ts';
import { isFullReview, type ReviewCategory } from '../../review-shape.ts';
import { completeDetailed, type GatewayDeps } from './gateway.ts';
import { modelContextWindow, resolveLlmConfig } from './config.ts';
import { logEvent } from '../log.ts';
import type { ChatMessage } from './providers/types.ts';

// Tool budgets for the exhaustive passes. A focused or full pass stages one
// tool call per note plus the scene read, so the account's conservative
// default would cut it off mid-review; the consistency pass must read every
// scene before it can compare anything. The gateway clamps both to its own
// ceiling.
const FOCUSED_PASS_BUDGET = 64;

// The world tiers (entities, lore, notes, the universe backbone) only matter to
// the lore category. A pass that checks spelling or prose alone is judged on the
// scene text and the style notes in the frame, so it ships the lean set instead
// and saves the rest of the prefill. The sparing pass (no categories) can raise
// anything, so it keeps the full stack.
const LEAN_REVIEW_TIERS = ['frame', 'summaries', 'scene-local'] as const;

function reviewTiers(categories: ReviewCategory[]): readonly string[] | undefined {
	if (categories.length === 0 || categories.includes('lore')) return undefined;
	return LEAN_REVIEW_TIERS;
}
// The continuity pass runs in two stages (see prompts/review.ts). The numbers
// below size each one; like the context budgets they are provisional.
//
// The survey listing takes about half the reviewer model's context window,
// leaving the other half for the persona, the story frame, and the reply; where
// the window is unknown, the same provisional default the context assembly
// uses. A listing that overruns it is split into sequential chunks.
const SURVEY_WINDOW_SHARE = 0.5;
const SURVEY_FALLBACK_TOKENS = 6000;
// Confirm rounds carry the full text of the scenes a candidate names, so each
// body is capped at a quarter of the same budget (four scenes' worth of room).
const CONFIRM_SCENE_SHARE = 4;
// The most candidates one pass will confirm. A confirm round costs a request
// each, so a survey that flags everything is cut off rather than run for hours;
// the result reports that it was capped.
const MAX_CANDIDATES = 24;
// A confirm round reads no scenes (the text is in the message) and stages at
// most a note or two, so a small budget is enough.
const CONFIRM_TOOL_BUDGET = 6;
// Only the two note-staging tools are offered; nothing else has a job here.
const CONFIRM_TOOL_NAMES = ['leave_comment', 'suggest_edit'];

function surveyBudgetTokens(contextWindow: number | undefined): number {
	if (!contextWindow) return SURVEY_FALLBACK_TOKENS;
	return Math.max(1000, Math.floor(contextWindow * SURVEY_WINDOW_SHARE));
}

function confirmBodyChars(budgetTokens: number): number {
	return Math.floor((budgetTokens * 4) / CONFIRM_SCENE_SHARE);
}

// The Assistant-as-reviewer run, shared by the inline single-scene endpoint and
// the whole-story / chapter background job. It assembles the scene's context,
// asks the reviewer to leave its notes through the staging tools, and runs the
// gateway. Nothing here touches the prose: suggest_edit / leave_comment stage
// review suggestions and comments the author later accepts or rejects.

// The Assistant's pending notes on a scene, for reporting how many a run added.
export async function countAssistantNotes(db: Database, sceneId: string): Promise<number> {
	const [suggestions] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(reviewSuggestions)
		.where(
			and(
				eq(reviewSuggestions.sceneId, sceneId),
				eq(reviewSuggestions.assistant, true),
				eq(reviewSuggestions.status, 'pending')
			)
		);
	const [comments] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(reviewComments)
		.innerJoin(reviewThreads, eq(reviewComments.threadId, reviewThreads.id))
		.where(and(eq(reviewThreads.sceneId, sceneId), eq(reviewComments.assistant, true)));
	return (suggestions?.n ?? 0) + (comments?.n ?? 0);
}

// The Assistant's still-open notes on a scene, carried into the next review
// run so it does not stage the same observations twice: its comments on
// unresolved standalone threads, and its pending suggestions with the passage
// each was anchored to.
export async function openAssistantNotes(db: Database, sceneId: string): Promise<PriorNote[]> {
	const comments = await db
		.select({ body: reviewComments.bodyMd, createdAt: reviewComments.createdAt })
		.from(reviewComments)
		.innerJoin(reviewThreads, eq(reviewComments.threadId, reviewThreads.id))
		.where(
			and(
				eq(reviewThreads.sceneId, sceneId),
				isNull(reviewThreads.resolvedAt),
				isNull(reviewThreads.suggestionId),
				eq(reviewComments.assistant, true)
			)
		)
		.orderBy(asc(reviewComments.createdAt));
	const suggestions = await db
		.select({
			rangeStart: reviewSuggestions.rangeStart,
			rangeEnd: reviewSuggestions.rangeEnd,
			replacement: reviewSuggestions.replacement,
			baseBody: revisions.bodyMd,
			createdAt: reviewSuggestions.createdAt
		})
		.from(reviewSuggestions)
		.innerJoin(revisions, eq(reviewSuggestions.baseRevisionId, revisions.id))
		.where(
			and(
				eq(reviewSuggestions.sceneId, sceneId),
				eq(reviewSuggestions.assistant, true),
				eq(reviewSuggestions.status, 'pending')
			)
		)
		.orderBy(asc(reviewSuggestions.createdAt));
	return [
		...comments.map((c) => ({ kind: 'comment' as const, body: c.body })),
		...suggestions.map((s) => ({
			kind: 'suggestion' as const,
			quote: s.baseBody.slice(s.rangeStart, s.rangeEnd),
			body: s.replacement
		}))
	];
}

// One scene through the reviewer. Returns how many notes the run staged.
// Throws if the gateway fails (no endpoint, unreachable, disabled), so the
// caller can report it.
//
// storyFrame is the scene-independent context, assembled once by a multi-scene
// caller: the system message is then identical from scene to scene, and only
// the scene-local delta changes, in the user message. Without it the scene
// carries the whole seven-tier assembly in its system message, which is what a
// single inline review wants.
export async function reviewOneScene(
	db: Database,
	opts: {
		userId: string;
		storyId: string;
		scene: { id: string; title: string | null };
		categories?: ReviewCategory[];
		storyFrame?: AssembledContext;
		signal?: AbortSignal;
	},
	deps: GatewayDeps = {}
): Promise<number> {
	const categories = opts.categories ?? [];
	const includeTiers = reviewTiers(categories);
	let system: ChatMessage | null = null;
	let scenePrefix = '';
	let sceneTextIncluded = false;
	if (opts.storyFrame) {
		system = buildSystemMessage(opts.storyFrame, { tools: true });
		const delta = await assembleSceneDelta(db, {
			userId: opts.userId,
			storyId: opts.storyId,
			sceneId: opts.scene.id,
			entityNames: opts.storyFrame.sources.entities.map((e) => e.name),
			includeTiers
		});
		if (delta?.text) scenePrefix = `${delta.text}\n\n`;
		sceneTextIncluded = delta?.includedTiers.includes('scene-local') ?? false;
	} else {
		const context = await assembleContext(db, {
			userId: opts.userId,
			storyId: opts.storyId,
			sceneId: opts.scene.id,
			includeTiers
		});
		if (context) {
			system = buildSystemMessage(context, { tools: true });
			sceneTextIncluded = context.includedTiers.includes('scene-local');
		}
	}
	const prior = await openAssistantNotes(db, opts.scene.id);
	const task: ChatMessage = {
		role: 'user',
		content: scenePrefix + buildReviewMessage(opts.scene, prior, categories, sceneTextIncluded)
	};
	const messages: ChatMessage[] = system ? [system, task] : [task];
	const result = await completeDetailed(
		db,
		{
			userId: opts.userId,
			storyId: opts.storyId,
			role: 'reviewer',
			enableTools: true,
			messages,
			...(categories.length === 0 ? {} : { toolBudget: FOCUSED_PASS_BUDGET }),
			signal: opts.signal
		},
		deps
	);
	return result.notes;
}

// The world context both stages sit on. The survey judges continuity from the
// summaries in its own message, so the frame (story, world, style) and the
// entities (the names, titles, and facts that drift) are what help; the outline
// would only repeat the listing, and the notes and the universe backbone say
// nothing about whether two scenes disagree.
const CONSISTENCY_TIERS = ['frame', 'entities'] as const;
const UNIVERSE_CONSISTENCY_TIERS = ['universe-frame', 'entities'] as const;

type ConsistencyScope = { storyId: string } | { universeId: string };

function scopeIds(scope: ConsistencyScope) {
	return 'storyId' in scope ? { storyId: scope.storyId } : { universeId: scope.universeId };
}

// What a consistency pass produced: the notes it staged, how many candidate
// contradictions the survey raised, and whether the candidate cap cut it short.
type ConsistencyPassResult = { notes: number; candidates: number; capped: boolean };

// Stage A over one chunk of the listing: no tools, structured output, and one
// corrective retry when the reply does not parse. Throws when the second reply
// is unreadable too, so the run fails loudly rather than reporting a clean pass
// it never made.
async function surveyChunk(
	db: Database,
	opts: {
		userId: string;
		scope: ConsistencyScope;
		system: ChatMessage | null;
		scenes: SurveyScene[];
		chunk?: { index: number; total: number };
		signal?: AbortSignal;
	},
	deps: GatewayDeps
): Promise<ContinuityCandidate[]> {
	const task: ChatMessage = {
		role: 'user',
		content: buildSurveyMessage(opts.scenes, {
			scope: 'storyId' in opts.scope ? 'story' : 'universe',
			chunk: opts.chunk
		})
	};
	const messages: ChatMessage[] = opts.system ? [opts.system, task] : [task];
	const request = {
		userId: opts.userId,
		...scopeIds(opts.scope),
		role: 'reviewer' as const,
		signal: opts.signal
	};
	const first = await completeDetailed(db, { ...request, messages }, deps);
	const parsed = parseCandidates(first.content);
	if (parsed) return parsed;
	const retry = await completeDetailed(
		db,
		{
			...request,
			messages: [
				...messages,
				{ role: 'assistant', content: first.content },
				{ role: 'user', content: SURVEY_RETRY_MESSAGE }
			]
		},
		deps
	);
	const reparsed = parseCandidates(retry.content);
	if (reparsed) return reparsed;
	throw new Error(
		'The continuity survey did not answer with the JSON it was asked for, twice in a row. Nothing was staged.'
	);
}

// The shared body of every consistency pass, in two stages: survey the scene
// summaries for candidate contradictions (no tools, one request per chunk of
// the listing), then confirm each candidate against the full text of the scenes
// it names (the note-staging tools only). The scope drives the assembled
// context and the gateway's retrieval reach (a story focus, or the whole
// universe). Throws on gateway failure, like reviewOneScene.
async function runConsistencyPass(
	db: Database,
	opts: {
		userId: string;
		scope: ConsistencyScope;
		scenes: SurveyScene[];
		signal?: AbortSignal;
	},
	deps: GatewayDeps = {}
): Promise<ConsistencyPassResult> {
	const story = 'storyId' in opts.scope ? opts.scope.storyId : undefined;
	const resolved = await resolveLlmConfig(db, opts.userId, story);
	const budgetTokens = surveyBudgetTokens(modelContextWindow(resolved.config, 'reviewer'));

	const context = story
		? await assembleStoryFrame(db, {
				userId: opts.userId,
				storyId: story,
				includeTiers: CONSISTENCY_TIERS
			})
		: await assembleContext(db, {
				userId: opts.userId,
				universeId: (opts.scope as { universeId: string }).universeId,
				includeTiers: UNIVERSE_CONSISTENCY_TIERS
			});
	// Both stages carry the world context without the tool hint: the survey has
	// no tools at all, and the confirm rounds are handed the scene text already.
	const system = context ? buildSystemMessage(context) : null;

	const chunks = splitSurveyChunks(opts.scenes, budgetTokens);
	const candidates: ContinuityCandidate[] = [];
	for (const [i, chunk] of chunks.entries()) {
		opts.signal?.throwIfAborted();
		candidates.push(
			...(await surveyChunk(
				db,
				{
					userId: opts.userId,
					scope: opts.scope,
					system,
					scenes: chunk,
					...(chunks.length > 1 ? { chunk: { index: i + 1, total: chunks.length } } : {}),
					signal: opts.signal
				},
				deps
			))
		);
	}

	const capped = candidates.length > MAX_CANDIDATES;
	if (capped) {
		logEvent('info', 'assistant.continuity.capped', {
			userId: opts.userId,
			...scopeIds(opts.scope),
			candidates: candidates.length,
			cap: MAX_CANDIDATES
		});
	}

	const byId = new Map(opts.scenes.map((scene) => [scene.id, scene]));
	const bodyChars = confirmBodyChars(budgetTokens);
	let notes = 0;
	for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
		opts.signal?.throwIfAborted();
		// A scene id the survey invented is dropped; a candidate that names none
		// we know is skipped entirely.
		const involved = [...new Set(candidate.sceneIds)]
			.map((id) => byId.get(id))
			.filter((scene): scene is SurveyScene => Boolean(scene));
		if (involved.length < candidate.sceneIds.length) {
			logEvent('info', 'assistant.continuity.unknown-scene', {
				userId: opts.userId,
				...scopeIds(opts.scope),
				named: candidate.sceneIds.length,
				known: involved.length
			});
		}
		if (!involved.length) continue;
		const task: ChatMessage = {
			role: 'user',
			content: buildConfirmMessage(candidate.claim, involved, bodyChars)
		};
		const result = await completeDetailed(
			db,
			{
				userId: opts.userId,
				...scopeIds(opts.scope),
				role: 'reviewer',
				enableTools: true,
				toolNames: CONFIRM_TOOL_NAMES,
				toolBudget: CONFIRM_TOOL_BUDGET,
				messages: system ? [system, task] : [task],
				signal: opts.signal
			},
			deps
		);
		notes += result.notes;
	}
	return { notes, candidates: candidates.length, capped };
}

// The story's scenes in order, owner-scoped, with what both stages need: the
// summary (or the body it falls back to) for the survey, the full body for the
// confirm rounds.
async function storySurveyScenes(
	db: Database,
	userId: string,
	storyId: string
): Promise<SurveyScene[]> {
	return db
		.select({
			id: scenes.id,
			title: scenes.title,
			summaryMd: scenes.summaryMd,
			bodyMd: scenes.bodyMd
		})
		.from(scenes)
		.innerJoin(stories, eq(scenes.storyId, stories.id))
		.where(and(eq(scenes.storyId, storyId), eq(stories.ownerId, userId), isNull(scenes.deletedAt)))
		.orderBy(asc(scenes.globalPosition));
}

// The cross-scene pass of a full story review: the two-stage continuity run
// over every scene, looking only for issues that span scenes. Anchors its notes
// like any other review note. Returns how many notes it staged. Throws on
// gateway failure, like reviewOneScene.
export async function reviewStoryConsistency(
	db: Database,
	opts: {
		userId: string;
		storyId: string;
		signal?: AbortSignal;
	},
	deps: GatewayDeps = {}
): Promise<number> {
	const surveyScenes = await storySurveyScenes(db, opts.userId, opts.storyId);
	if (surveyScenes.length < 2) return 0;
	const result = await runConsistencyPass(
		db,
		{
			userId: opts.userId,
			scope: { storyId: opts.storyId },
			scenes: surveyScenes,
			signal: opts.signal
		},
		deps
	);
	return result.notes;
}

// How a standalone continuity review went: how many scenes were in scope, how
// many notes it staged, and whether the pass ran at all (it is skipped when
// there is nothing to compare, fewer than two scenes). candidates and capped
// report the survey stage: how many contradictions it raised, and whether the
// cap left some unconfirmed.
export type ContinuityReviewResult = {
	scenes: number;
	notes: number;
	ran: boolean;
	candidates?: number;
	capped?: boolean;
};

// A standalone story continuity review: the consistency pass on its own, with
// no per-scene copyedit passes before it. Reuses reviewStoryConsistency over
// every non-deleted scene in the story, owner-scoped. Skipped when the story has
// fewer than two scenes (nothing spans).
export async function reviewStoryContinuity(
	db: Database,
	opts: { userId: string; storyId: string; signal?: AbortSignal },
	deps: GatewayDeps = {}
): Promise<ContinuityReviewResult> {
	const targets = await storySurveyScenes(db, opts.userId, opts.storyId);
	if (targets.length < 2) return { scenes: targets.length, notes: 0, ran: false };
	const result = await runConsistencyPass(
		db,
		{
			userId: opts.userId,
			scope: { storyId: opts.storyId },
			scenes: targets,
			signal: opts.signal
		},
		deps
	);
	return {
		scenes: targets.length,
		notes: result.notes,
		ran: true,
		candidates: result.candidates,
		capped: result.capped
	};
}

// A universe-wide continuity review: one pass across every story in the
// universe, looking for facts that contradict each other between books. The
// universe-scoped tools reach any story, and leave_comment resolves a scene's
// own owning story, so a contradiction found in one story anchors there even
// though the pass was launched at the universe. Skipped when the universe holds
// fewer than two scenes.
export async function reviewUniverseContinuity(
	db: Database,
	opts: { userId: string; universeId: string; signal?: AbortSignal },
	deps: GatewayDeps = {}
): Promise<ContinuityReviewResult> {
	// Ordered by story, then story order within it, so the survey listing groups
	// each story's scenes together.
	const rows = await db
		.select({
			id: scenes.id,
			title: scenes.title,
			summaryMd: scenes.summaryMd,
			bodyMd: scenes.bodyMd,
			storyTitle: stories.title
		})
		.from(scenes)
		.innerJoin(stories, eq(scenes.storyId, stories.id))
		.where(
			and(
				eq(stories.universeId, opts.universeId),
				eq(stories.ownerId, opts.userId),
				isNull(scenes.deletedAt)
			)
		)
		.orderBy(asc(stories.title), asc(scenes.globalPosition));
	if (rows.length < 2) return { scenes: rows.length, notes: 0, ran: false };

	const result = await runConsistencyPass(
		db,
		{
			userId: opts.userId,
			scope: { universeId: opts.universeId },
			scenes: rows,
			signal: opts.signal
		},
		deps
	);
	return {
		scenes: rows.length,
		notes: result.notes,
		ran: true,
		candidates: result.candidates,
		capped: result.capped
	};
}

export type StoryReviewResult = { reviewed: number; failed: number; notes: number };

// A whole-story or single-chapter review: every non-deleted scene in scope,
// owner-scoped through the story. Errors on one scene are caught so a single
// unreachable turn does not abandon the rest; the result reports how many
// scenes were reviewed, how many failed, and how many notes were staged.
export async function reviewStoryScenes(
	db: Database,
	opts: {
		userId: string;
		storyId: string;
		chapterId?: string;
		categories?: ReviewCategory[];
		signal?: AbortSignal;
	},
	deps: GatewayDeps = {}
): Promise<StoryReviewResult> {
	const where = [
		eq(scenes.storyId, opts.storyId),
		eq(stories.ownerId, opts.userId),
		isNull(scenes.deletedAt)
	];
	if (opts.chapterId) where.push(eq(scenes.chapterId, opts.chapterId));
	const targets = await db
		.select({ id: scenes.id, title: scenes.title })
		.from(scenes)
		.innerJoin(stories, eq(scenes.storyId, stories.id))
		.where(and(...where))
		.orderBy(asc(scenes.globalPosition));

	// The scene-independent context, assembled once for the whole run: every
	// scene then shares one system message, byte for byte, so an endpoint's
	// prompt prefix cache holds across the run.
	const storyFrame =
		targets.length > 0
			? ((await assembleStoryFrame(db, {
					userId: opts.userId,
					storyId: opts.storyId,
					includeTiers: reviewTiers(opts.categories ?? [])
				})) ?? undefined)
			: undefined;

	let reviewed = 0;
	let failed = 0;
	let notes = 0;
	for (const scene of targets) {
		try {
			notes += await reviewOneScene(
				db,
				{
					userId: opts.userId,
					storyId: opts.storyId,
					scene,
					categories: opts.categories,
					storyFrame,
					signal: opts.signal
				},
				deps
			);
			reviewed += 1;
		} catch {
			failed += 1;
		}
	}
	// A full review ends with one cross-scene pass: the only run that can see
	// drift between scenes (names, timelines, idiom conventions). Pointless
	// for a single scene, and skipped when every per-scene pass failed.
	if (isFullReview(opts.categories ?? []) && targets.length > 1 && reviewed > 0) {
		try {
			notes += await reviewStoryConsistency(
				db,
				{ userId: opts.userId, storyId: opts.storyId, signal: opts.signal },
				deps
			);
		} catch {
			failed += 1;
		}
	}
	return { reviewed, failed, notes };
}
