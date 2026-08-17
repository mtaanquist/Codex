import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../auth.ts';
import {
	reviewComments,
	reviewSuggestions,
	reviewThreads,
	revisions,
	scenes,
	stories,
	type ReviewFailure,
	type ReviewRunState
} from '../db/schema.ts';
import {
	adoptCappedRun,
	emptyReviewRun,
	loadReviewRun,
	reviewScopeKey,
	saveReviewRun
} from '../review-runs.ts';
import { needsSummary, summariseStory } from './summaries.ts';
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
import { CAP_NOT_APPLIED_MESSAGE, SpendMeter } from './spend.ts';
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

export function reviewTiers(categories: ReviewCategory[]): readonly string[] | undefined {
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

export function surveyBudgetTokens(contextWindow: number | undefined): number {
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

// What one pass produced: the notes it staged, and why it had to stop calling
// tools when it did not finish on its own.
export type ScenePassResult = {
	notes: number;
	stopped?: 'context' | 'budget';
	// Set when the run's spend ceiling stopped the pass part-way.
	spendCapped?: boolean;
};

// The text a caught error contributes to a failure list. Long provider messages
// are cut so a notification title stays readable.
const MAX_FAILURE_MESSAGE = 200;

export function failureMessage(err: unknown): string {
	const text = (err instanceof Error ? err.message : String(err)).trim();
	if (!text) return 'The review failed for an unknown reason.';
	return text.length > MAX_FAILURE_MESSAGE ? `${text.slice(0, MAX_FAILURE_MESSAGE)}...` : text;
}

// A pass that answered but was cut short is a degraded outcome, not a clean
// run, so it is named in the failure list even though nothing threw.
export function stoppedMessage(stopped: 'context' | 'budget'): string {
	return stopped === 'context'
		? 'Stopped early: the scene filled the model context window.'
		: 'Stopped early: the run reached its tool-call limit.';
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
		// Accumulates what this pass spends, for a run with a ceiling.
		meter?: SpendMeter;
		signal?: AbortSignal;
	},
	deps: GatewayDeps = {}
): Promise<ScenePassResult> {
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
	opts.meter?.record(result.model, result.usage);
	return { notes: result.notes, ...(result.stopped ? { stopped: result.stopped } : {}) };
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
// contradictions the survey raised, whether the candidate cap cut it short, and
// whether a confirm round had to stop calling tools before it was done.
type ConsistencyPassResult = {
	notes: number;
	candidates: number;
	capped: boolean;
	stopped?: 'context' | 'budget';
	// Set when the run's spend ceiling was reached and the remaining candidates
	// were left unconfirmed.
	spendCapped?: boolean;
};

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
		meter?: SpendMeter;
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
	opts.meter?.record(first.model, first.usage);
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
	opts.meter?.record(retry.model, retry.usage);
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
		meter?: SpendMeter;
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
	let spendCapped = false;
	for (const [i, chunk] of chunks.entries()) {
		opts.signal?.throwIfAborted();
		// Between chunks, like between candidates below: the survey has staged
		// nothing yet, so stopping here loses only the chunks not yet listed.
		if (opts.meter?.capReached) {
			spendCapped = true;
			break;
		}
		candidates.push(
			...(await surveyChunk(
				db,
				{
					userId: opts.userId,
					scope: opts.scope,
					system,
					scenes: chunk,
					...(chunks.length > 1 ? { chunk: { index: i + 1, total: chunks.length } } : {}),
					meter: opts.meter,
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
	let stopped: ConsistencyPassResult['stopped'];
	for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
		opts.signal?.throwIfAborted();
		// Between candidates is the boundary where stopping stages nothing partial.
		if (opts.meter?.capReached) {
			spendCapped = true;
			break;
		}
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
		opts.meter?.record(result.model, result.usage);
		notes += result.notes;
		stopped ??= result.stopped;
	}
	return {
		notes,
		candidates: candidates.length,
		capped,
		...(stopped ? { stopped } : {}),
		...(spendCapped ? { spendCapped: true } : {})
	};
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
// like any other review note. Returns how many notes it staged, and why the run
// stopped calling tools when it was cut short. Throws on gateway failure, like
// reviewOneScene.
export async function reviewStoryConsistency(
	db: Database,
	opts: {
		userId: string;
		storyId: string;
		meter?: SpendMeter;
		signal?: AbortSignal;
	},
	deps: GatewayDeps = {}
): Promise<ScenePassResult> {
	const surveyScenes = await storySurveyScenes(db, opts.userId, opts.storyId);
	if (surveyScenes.length < 2) return { notes: 0 };
	const result = await runConsistencyPass(
		db,
		{
			userId: opts.userId,
			scope: { storyId: opts.storyId },
			scenes: surveyScenes,
			meter: opts.meter,
			signal: opts.signal
		},
		deps
	);
	return {
		notes: result.notes,
		...(result.stopped ? { stopped: result.stopped } : {}),
		...(result.spendCapped ? { spendCapped: true } : {})
	};
}

// Scenes whose summary is missing or out of date, by the same rule the summary
// pass applies. Checked before a story-level review so the run only enters the
// summary pass when there is something for it to write.
async function staleSummaryCount(db: Database, userId: string, storyId: string): Promise<number> {
	const rows = await db
		.select({
			bodyMd: scenes.bodyMd,
			summaryMd: scenes.summaryMd,
			summaryGeneratedAt: scenes.summaryGeneratedAt,
			updatedAt: scenes.updatedAt
		})
		.from(scenes)
		.innerJoin(stories, eq(scenes.storyId, stories.id))
		.where(and(eq(scenes.storyId, storyId), eq(stories.ownerId, userId), isNull(scenes.deletedAt)));
	return rows.filter(
		(row) =>
			Boolean(row.bodyMd && row.bodyMd.trim()) &&
			needsSummary({
				summaryMd: row.summaryMd,
				summaryGeneratedAt: row.summaryGeneratedAt,
				changedSince: row.summaryGeneratedAt
					? row.updatedAt.getTime() > row.summaryGeneratedAt.getTime()
					: false
			})
	).length;
}

// A story-level review reads scene summaries (the survey stage works from them
// alone), so it brings them up to date first. The summary pass skips fresh rows
// internally; the count above keeps the run out of it entirely when nothing is
// stale. A failure here is reported, not fatal: the review still runs on the
// summaries that exist.
async function refreshSummaries(
	db: Database,
	opts: { userId: string; storyId: string; meter?: SpendMeter; signal?: AbortSignal },
	deps: GatewayDeps
): Promise<{ refreshed: boolean; failures: ReviewFailure[]; capped: boolean }> {
	try {
		if ((await staleSummaryCount(db, opts.userId, opts.storyId)) === 0) {
			return { refreshed: false, failures: [], capped: false };
		}
		const result = await summariseStory(db, opts, deps);
		const failures: ReviewFailure[] =
			result.failed > 0
				? [
						{
							message: `${result.failed} summar${result.failed === 1 ? 'y' : 'ies'} could not be written before the review.`
						}
					]
				: [];
		// The ceiling is shared with the rest of the run, so a summary phase that
		// spends it stops the review before it starts. Said plainly here, or the
		// run reports a stop with nothing to explain it.
		if (result.capped) failures.push({ message: SUMMARIES_CAPPED_MESSAGE });
		return {
			refreshed: result.scenes + result.chapters > 0,
			failures,
			capped: result.capped ?? false
		};
	} catch (err) {
		return {
			refreshed: false,
			failures: [{ message: `Summaries could not be updated: ${failureMessage(err)}` }],
			capped: false
		};
	}
}

export const SUMMARIES_CAPPED_MESSAGE =
	'The spend cap was reached while the summaries were being brought up to date.';

// How a standalone continuity review went: how many scenes were in scope, how
// many notes it staged, and whether the pass ran at all (it is skipped when
// there is nothing to compare, fewer than two scenes). candidates and
// candidatesCapped report the survey stage: how many contradictions it raised,
// and whether the candidate cap left some unconfirmed. failures names anything
// degraded that did not stop the run (a summary that could not be written, a
// pass cut short).
export type ContinuityReviewResult = {
	scenes: number;
	notes: number;
	ran: boolean;
	candidates?: number;
	candidatesCapped?: boolean;
	failures?: ReviewFailure[];
	summariesRefreshed?: boolean;
	// Set when the run stopped because it had spent the account's ceiling.
	capped?: boolean;
	spentUsd?: number;
};

// The run state a review writes as it advances, when it was queued with a job
// id. Progress is a convenience: a write that fails is logged and the review
// carries on, and without a job id nothing is stored at all (the inline and
// test callers).
type RunWriter = { state: ReviewRunState; save: () => Promise<void> };

async function openRun(
	db: Database,
	opts: { jobId?: string; userId: string; scope: string }
): Promise<RunWriter> {
	let state: ReviewRunState | null = null;
	if (opts.jobId) {
		try {
			state = await loadReviewRun(db, opts.jobId);
			// A capped run completes its job, so the writer's "run the review again
			// to continue" arrives as a new job with no row of its own. The capped
			// run over the same scope is adopted under the new id, so the scenes it
			// already reviewed are not reviewed (and billed) a second time.
			state ??= await adoptCappedRun(db, { userId: opts.userId, scope: opts.scope });
		} catch (err) {
			console.error('review run: reading progress failed:', err);
		}
	}
	const current = state ?? emptyReviewRun();
	current.scope = opts.scope;
	// A resumed run is a fresh attempt with the whole ceiling again, so the
	// earlier attempt's stop flags and spend do not carry into it.
	current.capped = false;
	current.aborted = false;
	current.spentUsd = 0;
	return {
		state: current,
		async save() {
			if (!opts.jobId) return;
			try {
				await saveReviewRun(db, { jobId: opts.jobId, userId: opts.userId, state: current });
			} catch (err) {
				console.error('review run: saving progress failed:', err);
			}
		}
	};
}

// A standalone story continuity review: the consistency pass on its own, with
// no per-scene copyedit passes before it. Reuses reviewStoryConsistency over
// every non-deleted scene in the story, owner-scoped. Skipped when the story has
// fewer than two scenes (nothing spans).
export async function reviewStoryContinuity(
	db: Database,
	opts: { userId: string; storyId: string; jobId?: string; signal?: AbortSignal },
	deps: GatewayDeps = {}
): Promise<ContinuityReviewResult> {
	const run = await openRun(db, {
		...opts,
		scope: reviewScopeKey({ storyId: opts.storyId, mode: 'continuity' })
	});
	// Fresh per attempt: the pass re-runs from the start every time, so a retry
	// after a crash must not report the crash the earlier attempt hit.
	const failures: ReviewFailure[] = [];
	const resolved = await resolveLlmConfig(db, opts.userId, opts.storyId);
	const meter = new SpendMeter({
		pricing: resolved.config.modelPricing,
		capUsd: resolved.config.spendCapUsd
	});

	// The survey stage compares scene summaries, so they are brought up to date
	// before anything is compared.
	run.state.phase = 'summaries';
	await run.save();
	const summaries = await refreshSummaries(db, { ...opts, meter }, deps);
	failures.push(...summaries.failures);
	run.state.summariesRefreshed = summaries.refreshed;
	run.state.failures = failures;

	const targets = await storySurveyScenes(db, opts.userId, opts.storyId);
	run.state.total = targets.length;
	if (targets.length < 2) {
		run.state.phase = 'done';
		await run.save();
		return {
			scenes: targets.length,
			notes: 0,
			ran: false,
			failures,
			summariesRefreshed: summaries.refreshed
		};
	}
	// The summary phase shares the ceiling, so it can spend it before the pass
	// starts. Reported as a capped run rather than as a pass that found nothing.
	if (summaries.capped || meter.capReached) {
		run.state.phase = 'done';
		run.state.failures = failures;
		run.state.capped = true;
		run.state.spentUsd = meter.spentUsd;
		await run.save();
		return {
			scenes: targets.length,
			notes: 0,
			ran: false,
			failures,
			summariesRefreshed: summaries.refreshed,
			capped: true,
			spentUsd: meter.spentUsd
		};
	}
	run.state.phase = 'consistency';
	await run.save();
	let result: ConsistencyPassResult;
	try {
		result = await runConsistencyPass(
			db,
			{
				userId: opts.userId,
				scope: { storyId: opts.storyId },
				scenes: targets,
				meter,
				signal: opts.signal
			},
			deps
		);
	} catch (err) {
		run.state.failed += 1;
		run.state.failures = [...failures, { message: failureMessage(err) }];
		run.state.phase = 'done';
		await run.save();
		throw err;
	}
	if (result.stopped) failures.push({ message: stoppedMessage(result.stopped) });
	if (meter.notApplied) failures.push({ message: CAP_NOT_APPLIED_MESSAGE });
	run.state.notes += result.notes;
	run.state.failures = failures;
	run.state.phase = 'done';
	if (result.spendCapped) {
		run.state.capped = true;
		run.state.spentUsd = meter.spentUsd;
	}
	await run.save();
	return {
		scenes: targets.length,
		notes: result.notes,
		ran: true,
		candidates: result.candidates,
		candidatesCapped: result.capped,
		failures,
		summariesRefreshed: summaries.refreshed,
		...(result.spendCapped ? { capped: true, spentUsd: meter.spentUsd } : {})
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
	opts: { userId: string; universeId: string; jobId?: string; signal?: AbortSignal },
	deps: GatewayDeps = {}
): Promise<ContinuityReviewResult> {
	const run = await openRun(db, {
		...opts,
		scope: reviewScopeKey({ universeId: opts.universeId, mode: 'continuity' })
	});
	const resolved = await resolveLlmConfig(db, opts.userId);
	const meter = new SpendMeter({
		pricing: resolved.config.modelPricing,
		capUsd: resolved.config.spendCapUsd
	});
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
	run.state.total = rows.length;
	if (rows.length < 2) {
		run.state.phase = 'done';
		await run.save();
		return { scenes: rows.length, notes: 0, ran: false, failures: [] };
	}

	run.state.phase = 'consistency';
	await run.save();
	let result: ConsistencyPassResult;
	try {
		result = await runConsistencyPass(
			db,
			{
				userId: opts.userId,
				scope: { universeId: opts.universeId },
				scenes: rows,
				meter,
				signal: opts.signal
			},
			deps
		);
	} catch (err) {
		run.state.failed += 1;
		run.state.failures = [{ message: failureMessage(err) }];
		run.state.phase = 'done';
		await run.save();
		throw err;
	}
	const failures: ReviewFailure[] = result.stopped
		? [{ message: stoppedMessage(result.stopped) }]
		: [];
	if (meter.notApplied) failures.push({ message: CAP_NOT_APPLIED_MESSAGE });
	run.state.notes += result.notes;
	run.state.failures = failures;
	run.state.phase = 'done';
	if (result.spendCapped) {
		run.state.capped = true;
		run.state.spentUsd = meter.spentUsd;
	}
	await run.save();
	return {
		scenes: rows.length,
		notes: result.notes,
		ran: true,
		candidates: result.candidates,
		candidatesCapped: result.capped,
		failures,
		...(result.spendCapped ? { capped: true, spentUsd: meter.spentUsd } : {})
	};
}

// How a whole-story or chapter review went: the counts, everything degraded
// along the way (#528), whether the run was cancelled part-way, and whether it
// had to write summaries before it could start.
export type StoryReviewResult = {
	reviewed: number;
	failed: number;
	notes: number;
	failures: ReviewFailure[];
	aborted?: boolean;
	summariesRefreshed?: boolean;
	// How many scenes were in scope, so a report can say "N of M".
	total: number;
	// Set when the run stopped at a scene boundary because it had spent the
	// account's ceiling; a distinct outcome from a failure or a cancellation.
	// spentUsd is what it had spent when it stopped.
	capped?: boolean;
	spentUsd?: number;
};

// A whole-story or single-chapter review: every non-deleted scene in scope,
// owner-scoped through the story. Errors on one scene are caught so a single
// unreachable turn does not abandon the rest; the result reports how many
// scenes were reviewed, how many failed and why, and how many notes were
// staged. Cancelling through the signal stops the loop and marks the result
// aborted, rather than counting the scenes never reached as failures.
//
// With a jobId the run records its progress as it goes, so the status endpoint
// can show it and a retry of the same job skips the scenes already handled.
export async function reviewStoryScenes(
	db: Database,
	opts: {
		userId: string;
		storyId: string;
		chapterId?: string;
		categories?: ReviewCategory[];
		jobId?: string;
		signal?: AbortSignal;
	},
	deps: GatewayDeps = {}
): Promise<StoryReviewResult> {
	const run = await openRun(db, {
		...opts,
		scope: reviewScopeKey({ storyId: opts.storyId, chapterId: opts.chapterId })
	});
	const done = new Set(run.state.completed);
	const failures: ReviewFailure[] = [...run.state.failures];
	let reviewed = run.state.reviewed;
	let failed = run.state.failed;
	let notes = run.state.notes;

	// The ceiling is shared across every phase of the run (summaries, the scene
	// passes, the cross-scene pass), so one review cannot spend it several times
	// over.
	const resolved = await resolveLlmConfig(db, opts.userId, opts.storyId);
	const meter = new SpendMeter({
		pricing: resolved.config.modelPricing,
		capUsd: resolved.config.spendCapUsd
	});

	// Scene summaries feed both the context assembly and the cross-scene pass, so
	// the run brings them up to date before it reviews anything.
	run.state.phase = 'summaries';
	await run.save();
	const summaries = await refreshSummaries(db, { ...opts, meter }, deps);
	// The summary phase runs again on every attempt, so a message the earlier
	// attempt already recorded is not listed twice.
	for (const failure of summaries.failures) {
		if (!failures.some((seen) => seen.message === failure.message && !seen.sceneId)) {
			failures.push(failure);
		}
	}
	if (summaries.refreshed) run.state.summariesRefreshed = true;

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

	run.state.phase = 'scenes';
	run.state.total = targets.length;
	run.state.failures = failures;
	await run.save();

	let aborted = false;
	// A summary phase that spent the ceiling stops the run here: the scene loop
	// would break on its first check anyway, and this way the outcome is capped
	// rather than a review that reports nothing.
	let capped = summaries.capped;
	for (const scene of targets) {
		if (opts.signal?.aborted) {
			aborted = true;
			break;
		}
		// Checked between scenes, so a stop never leaves a scene half reviewed.
		if (meter.capReached) {
			capped = true;
			break;
		}
		if (done.has(scene.id)) continue;
		run.state.currentSceneTitle = scene.title;
		await run.save();
		try {
			const pass = await reviewOneScene(
				db,
				{
					userId: opts.userId,
					storyId: opts.storyId,
					scene,
					categories: opts.categories,
					storyFrame,
					meter,
					signal: opts.signal
				},
				deps
			);
			notes += pass.notes;
			reviewed += 1;
			if (pass.stopped) {
				failures.push({
					sceneId: scene.id,
					sceneTitle: scene.title,
					message: stoppedMessage(pass.stopped)
				});
			}
		} catch (err) {
			// A cancelled run is not a failed scene: stop where it was told to.
			if (opts.signal?.aborted) {
				aborted = true;
				break;
			}
			failed += 1;
			failures.push({ sceneId: scene.id, sceneTitle: scene.title, message: failureMessage(err) });
		}
		done.add(scene.id);
		run.state.completed = [...done];
		run.state.reviewed = reviewed;
		run.state.failed = failed;
		run.state.notes = notes;
		run.state.failures = failures;
		await run.save();
	}
	run.state.currentSceneTitle = null;

	// A full review ends with one cross-scene pass: the only run that can see
	// drift between scenes (names, timelines, idiom conventions). Pointless
	// for a single scene, and skipped when every per-scene pass failed.
	if (
		!aborted &&
		!capped &&
		!meter.capReached &&
		isFullReview(opts.categories ?? []) &&
		targets.length > 1 &&
		reviewed > 0
	) {
		run.state.phase = 'consistency';
		await run.save();
		try {
			const pass = await reviewStoryConsistency(
				db,
				{ userId: opts.userId, storyId: opts.storyId, meter, signal: opts.signal },
				deps
			);
			notes += pass.notes;
			if (pass.spendCapped) capped = true;
			if (pass.stopped) failures.push({ message: stoppedMessage(pass.stopped) });
		} catch (err) {
			if (opts.signal?.aborted) aborted = true;
			else {
				failed += 1;
				failures.push({ message: `The cross-scene pass failed: ${failureMessage(err)}` });
			}
		}
	}

	// A ceiling that could not be priced is reported rather than quietly ignored.
	if (meter.notApplied) failures.push({ message: CAP_NOT_APPLIED_MESSAGE });

	run.state.phase = 'done';
	run.state.reviewed = reviewed;
	run.state.failed = failed;
	run.state.notes = notes;
	run.state.failures = failures;
	if (aborted) run.state.aborted = true;
	if (capped) {
		run.state.capped = true;
		run.state.spentUsd = meter.spentUsd;
	}
	await run.save();
	return {
		reviewed,
		failed,
		notes,
		failures,
		total: targets.length,
		...(aborted ? { aborted: true } : {}),
		...(capped ? { capped: true, spentUsd: meter.spentUsd } : {}),
		...(summaries.refreshed ? { summariesRefreshed: true } : {})
	};
}
