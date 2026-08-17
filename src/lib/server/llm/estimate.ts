import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Database } from '../auth.ts';
import { assistantUsage, scenes, stories } from '../db/schema.ts';
import {
	assembleSceneDelta,
	assembleStoryFrame,
	buildSystemMessage,
	estimateTokens
} from './context/assemble.ts';
import {
	DEFAULT_SPEND_WARN_USD,
	modelContextWindow,
	pickModel,
	resolveLlmConfig,
	type ResolvedConfig
} from './config.ts';
import { buildSurveyMessage, splitSurveyChunks } from './prompts/review.ts';
import { isFullReview, type ReviewCategory } from '../../review-shape.ts';
import { reviewTiers, surveyBudgetTokens } from './scene-review.ts';

// The pre-flight estimate a review run is confirmed against: how many scenes it
// would read, roughly how many tokens that sends, and - only when the model that
// would answer actually has a price - roughly what that costs. No price means
// tokens alone; the estimate never guesses one.
//
// Read-only by construction: it assembles the same context the run would and
// counts it. Nothing is queued and no provider request is made.

// Provisional allowances, not measured. Each per-scene request carries the
// persona system message and, on a tool-enabled turn, the tool schemas; the task
// message adds its instructions and any prior notes on the scene.
const PERSONA_TOKENS = 120;
const TOOL_SCHEMA_TOKENS = 700;
const TASK_MESSAGE_TOKENS = 250;

// A reviewer turn is agentic: it reads, stages notes, and answers, resending the
// growing conversation each round. The single-request figure above is therefore
// multiplied. With enough of this account's own history on the model in play the
// multiplier is measured; otherwise this stated constant applies.
const STATIC_MULTIPLIER = 2.5;
// Below this many priced requests the history is too thin to draw a ratio from.
const HISTORY_MIN_ROWS = 5;
// Bounds on the measured multiplier, so one freak run cannot make the estimate
// absurd in either direction.
const MIN_MULTIPLIER = 1;
const MAX_MULTIPLIER = 10;

export type EstimateLine = {
	label: string;
	tokens?: number;
	// Set where a figure cannot be known before the run.
	note?: string;
};

export type ReviewEstimate = {
	scenes: number;
	estTokens: number;
	model: string;
	basis: 'history' | 'static';
	multiplier: number;
	lines: EstimateLine[];
	// Present only when the resolved model has a price in the discovered
	// snapshot. Absent means the cost is not known, not that it is zero.
	estCostUsd?: number;
	// The account's warning threshold, and its spend ceiling with whether that
	// ceiling can be applied at all (it cannot without a price).
	warnUsd: number;
	capUsd?: number;
	capEnforceable: boolean;
};

// How much bigger the actual prompt of a reviewer request has been than the
// single-request figure this estimate computes. Drawn from this account's own
// usage rows for the model in play; provisional, and it conflates the rounds of
// an agentic turn with the first request of one, so it reads low rather than
// high.
async function agenticMultiplier(
	db: Database,
	userId: string,
	model: string,
	perSceneTokens: number
): Promise<{ multiplier: number; basis: 'history' | 'static' }> {
	if (perSceneTokens <= 0) return { multiplier: STATIC_MULTIPLIER, basis: 'static' };
	const [row] = await db
		.select({
			requests: sql<number>`count(*)::int`,
			avgPrompt: sql<number>`coalesce(avg(${assistantUsage.promptTokens}), 0)::float`
		})
		.from(assistantUsage)
		.where(
			and(
				eq(assistantUsage.userId, userId),
				eq(assistantUsage.model, model),
				eq(assistantUsage.role, 'reviewer'),
				isNotNull(assistantUsage.promptTokens)
			)
		);
	if (!row || row.requests < HISTORY_MIN_ROWS || row.avgPrompt <= 0) {
		return { multiplier: STATIC_MULTIPLIER, basis: 'static' };
	}
	const measured = row.avgPrompt / perSceneTokens;
	return {
		multiplier: Math.min(Math.max(measured, MIN_MULTIPLIER), MAX_MULTIPLIER),
		basis: 'history'
	};
}

export type EstimateOptions = {
	userId: string;
	storyId: string;
	chapterId?: string;
	categories?: ReviewCategory[];
};

// Assembles what the run would send and counts it. Mirrors reviewStoryScenes:
// the stable story frame once, each scene's delta, and - for a full review of
// more than one scene - the cross-scene pass on top.
export async function estimateStoryReview(
	db: Database,
	opts: EstimateOptions
): Promise<ReviewEstimate> {
	const categories = opts.categories ?? [];
	const resolved = await resolveLlmConfig(db, opts.userId, opts.storyId);
	const model = pickModel(resolved.config, 'reviewer');
	const includeTiers = reviewTiers(categories);

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

	const frame =
		targets.length > 0
			? await assembleStoryFrame(db, {
					userId: opts.userId,
					storyId: opts.storyId,
					includeTiers
				})
			: null;
	const frameTokens = frame
		? estimateTokens(buildSystemMessage(frame, { tools: true }).content)
		: 0;

	let sceneTokens = 0;
	for (const scene of targets) {
		const delta = frame
			? await assembleSceneDelta(db, {
					userId: opts.userId,
					storyId: opts.storyId,
					sceneId: scene.id,
					entityNames: frame.sources.entities.map((e) => e.name),
					includeTiers
				})
			: null;
		sceneTokens +=
			frameTokens +
			PERSONA_TOKENS +
			TOOL_SCHEMA_TOKENS +
			TASK_MESSAGE_TOKENS +
			estimateTokens(delta?.text ?? '');
	}

	const { multiplier, basis } = await agenticMultiplier(
		db,
		opts.userId,
		model,
		targets.length > 0 ? sceneTokens / targets.length : 0
	);

	const lines: EstimateLine[] = [
		{
			label: `Reading the ${targets.length} scene${targets.length === 1 ? '' : 's'}`,
			tokens: Math.round(sceneTokens * multiplier)
		}
	];

	// The cross-scene pass runs after a full review of more than one scene, over
	// the whole story. Stage A is a listing this can size exactly; stage B is one
	// request per contradiction the survey raises, which nothing can know yet.
	let surveyTokens = 0;
	if (isFullReview(categories) && targets.length > 1) {
		surveyTokens = await surveyStageTokens(db, opts.userId, opts.storyId, resolved.config);
		lines.push({ label: 'Consistency pass, stage A (the survey)', tokens: surveyTokens });
		lines.push({
			label: 'Consistency pass, stage B (confirming what the survey raises)',
			note: 'Not known before the run: it depends on how many contradictions the survey finds.'
		});
	}

	// The survey is a single plain request per chunk, so the agentic multiplier
	// does not apply to it.
	const estTokens = Math.round(sceneTokens * multiplier + surveyTokens);
	const price = resolved.config.modelPricing?.[model];

	return {
		scenes: targets.length,
		estTokens,
		model,
		basis,
		multiplier: Math.round(multiplier * 100) / 100,
		lines,
		...(price ? { estCostUsd: estTokens * price.prompt } : {}),
		warnUsd: resolved.config.spendWarnUsd ?? DEFAULT_SPEND_WARN_USD,
		...(resolved.config.spendCapUsd ? { capUsd: resolved.config.spendCapUsd } : {}),
		capEnforceable: Boolean(price)
	};
}

// Stage A of the consistency pass: the scene listing, split into the chunks the
// real pass would send, plus each chunk's own framing.
async function surveyStageTokens(
	db: Database,
	userId: string,
	storyId: string,
	config: ResolvedConfig
): Promise<number> {
	const rows = await db
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
	if (rows.length < 2) return 0;

	const budgetTokens = surveyBudgetTokens(modelContextWindow(config, 'reviewer'));
	const chunks = splitSurveyChunks(rows, budgetTokens);
	const frame = await assembleStoryFrame(db, {
		userId,
		storyId,
		includeTiers: ['frame', 'entities']
	});
	const frameTokens = frame ? estimateTokens(buildSystemMessage(frame).content) : 0;
	return chunks.reduce(
		(sum, chunk, i) =>
			sum +
			frameTokens +
			PERSONA_TOKENS +
			estimateTokens(
				buildSurveyMessage(chunk, {
					scope: 'story',
					...(chunks.length > 1 ? { chunk: { index: i + 1, total: chunks.length } } : {})
				})
			),
		0
	);
}
