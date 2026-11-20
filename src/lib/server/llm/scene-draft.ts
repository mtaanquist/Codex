import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm';
import type { Database } from '../auth.ts';
import { assistantDrafts, scenes, stories } from '../db/schema.ts';
import { storyIsLive } from '../universe-scope.ts';
import { usableSceneSummary } from '../summary-currency.ts';
import { cacheWriteRate } from '../../assistant-cost.ts';
import {
	defaultDraftWords,
	draftExpectedTokens,
	draftMaxTokens,
	wordsForTokens,
	type SceneDraftDefaults,
	type SceneDraftEstimate
} from '../../scene-draft.ts';
import { wordCount } from '../../word-count.ts';
import {
	assembleContext,
	bodyExcerpt,
	bodyTail,
	buildSystemMessage,
	estimateTokens
} from './context/assemble.ts';
import { contextBudgetTokens, PERSONA_TOKENS } from './context/budgets.ts';
import {
	assistantLayout,
	modelContextWindow,
	pickModel,
	resolveLlmConfig,
	roleMaxTokens
} from './config.ts';
import { completeDetailed, NoModelError, type GatewayDeps } from './gateway.ts';
import { jobSpendMeter } from './job-spend.ts';
import { buildSceneDraftMessage } from './prompts/scene-draft.ts';
import { adapterKind } from './providers/presets.ts';
import { stoppedByWriter, type ChatMessage } from './providers/types.ts';

// A scene draft: one whole scene written to the writer's brief, as a
// background job. The job only ever writes the draft row (assistant_drafts);
// the scene itself changes when the writer accepts the draft, in
// scene-drafts.ts. Drafting is started by the writer and is not a model tool.

// How much of the following scene's opening stands in for a summary it does
// not have.
const FOLLOWING_OPENING_CHARS = 600;

export const DRAFT_STOPPED_NOTE = 'You stopped this draft before it finished.';
export const DRAFT_CUT_OFF_NOTE =
	'This draft stopped at the length limit, so it may end mid-scene. To give it more room, raise Longest reply for Write in its Tune window under Account, Assistant.';

type DraftScene = {
	id: string;
	storyId: string;
	title: string | null;
	bodyMd: string;
	summaryMd: string | null;
	summaryGeneratedAt: Date | null;
	updatedAt: Date;
	globalPosition: number;
};

// The live scene, when it is in a live story of this user's.
async function draftScene(
	db: Database,
	userId: string,
	storyId: string,
	sceneId: string
): Promise<DraftScene | null> {
	const [scene] = await db
		.select({
			id: scenes.id,
			storyId: scenes.storyId,
			title: scenes.title,
			bodyMd: scenes.bodyMd,
			summaryMd: scenes.summaryMd,
			summaryGeneratedAt: scenes.summaryGeneratedAt,
			updatedAt: scenes.updatedAt,
			globalPosition: scenes.globalPosition
		})
		.from(scenes)
		.innerJoin(stories, eq(scenes.storyId, stories.id))
		.where(
			and(
				eq(scenes.id, sceneId),
				eq(scenes.storyId, storyId),
				eq(stories.ownerId, userId),
				storyIsLive(),
				isNull(scenes.deletedAt)
			)
		);
	return scene ?? null;
}

// What the brief form opens with: the scene's own summary as the brief (the
// writer's, or the Assistant's while it still tells the scene as it stands),
// and the story's usual scene length. Null when the scene is not the user's.
export async function sceneDraftDefaults(
	db: Database,
	opts: { userId: string; storyId: string; sceneId: string }
): Promise<SceneDraftDefaults | null> {
	const scene = await draftScene(db, opts.userId, opts.storyId, opts.sceneId);
	if (!scene) return null;
	const counts = await db
		.select({ wordCount: scenes.wordCount })
		.from(scenes)
		.where(and(eq(scenes.storyId, scene.storyId), isNull(scenes.deletedAt)));
	return {
		brief: usableSceneSummary(scene) ?? '',
		targetWords: defaultDraftWords(counts.map((row) => row.wordCount)),
		sceneTitle: scene.title
	};
}

export type SceneDraftInput = {
	userId: string;
	storyId: string;
	sceneId: string;
	brief: string;
	targetWords: number;
	pov?: string | null;
};

// The scene after this one in story order, as the draft is told about it: its
// summary when that is usable, else how it opens.
async function followingScene(db: Database, scene: DraftScene) {
	const [next] = await db
		.select({
			title: scenes.title,
			bodyMd: scenes.bodyMd,
			summaryMd: scenes.summaryMd,
			summaryGeneratedAt: scenes.summaryGeneratedAt,
			updatedAt: scenes.updatedAt
		})
		.from(scenes)
		.where(
			and(
				eq(scenes.storyId, scene.storyId),
				isNull(scenes.deletedAt),
				gt(scenes.globalPosition, scene.globalPosition)
			)
		)
		.orderBy(asc(scenes.globalPosition))
		.limit(1);
	if (!next) return null;
	const summary = usableSceneSummary(next);
	if (summary) return { title: next.title, text: summary, kind: 'summary' as const };
	const opening = bodyExcerpt(next.bodyMd, FOLLOWING_OPENING_CHARS);
	return opening ? { title: next.title, text: opening, kind: 'opening' as const } : null;
}

// The request a draft would send as things stand, and what bounds its reply.
// Null when the scene is not the user's. Throws NoModelError when no model is
// chosen for the role.
async function sceneDraftRequest(db: Database, input: SceneDraftInput) {
	const scene = await draftScene(db, input.userId, input.storyId, input.sceneId);
	if (!scene) return null;
	const { config } = await resolveLlmConfig(db, input.userId, input.storyId);
	// Drafting runs as the co-author, so its model and Tune settings apply.
	const model = pickModel(config, 'coauthor');
	if (!model) throw new NoModelError();
	const contextWindow = modelContextWindow(config, 'coauthor');
	// The world, the scenes around this one, and the previous scene's prose for
	// voice. The current scene's own prose rides in the same context.
	const context = await assembleContext(db, {
		userId: input.userId,
		storyId: input.storyId,
		sceneId: input.sceneId,
		focusText: input.brief,
		precedingProse: true,
		budgetTokens: contextBudgetTokens(contextWindow)
	});
	const task: ChatMessage = {
		role: 'user',
		content: buildSceneDraftMessage({
			brief: input.brief,
			targetWords: input.targetWords,
			pov: input.pov,
			existingProse: scene.bodyMd.trim() ? bodyTail(scene.bodyMd) : null,
			following: await followingScene(db, scene)
		})
	};
	const messages: ChatMessage[] = context ? [buildSystemMessage(context), task] : [task];
	const maxTokens = draftMaxTokens(input.targetWords, contextWindow);
	return {
		scene,
		config,
		model,
		messages,
		maxTokens,
		// A reply length the writer set for the role wins in the gateway.
		replyLimit: roleMaxTokens(config, 'coauthor') ?? maxTokens
	};
}

// What the draft would send and cost, counted without sending anything. Null
// when the scene is not the user's. Throws NoModelError when no model is chosen.
export async function estimateSceneDraft(
	db: Database,
	input: SceneDraftInput
): Promise<SceneDraftEstimate | null> {
	const request = await sceneDraftRequest(db, input);
	if (!request) return null;
	const { config, model } = request;
	const estTokens =
		PERSONA_TOKENS +
		request.messages.reduce((sum, message) => sum + estimateTokens(message.content), 0);
	const expected = draftExpectedTokens(input.targetWords);
	const limited = request.replyLimit < expected;
	const estCompletionTokens = limited ? request.replyLimit : expected;
	const price = config.modelPricing?.[model];
	// Claude bills text it has not seen before above the plain price, to cache it.
	const firstReadRate =
		adapterKind(config.provider) === 'anthropic' ? cacheWriteRate(config.cacheTtl) : 1;
	const estCostUsd = price
		? estTokens * firstReadRate * price.prompt + estCompletionTokens * price.completion
		: undefined;
	const capUsd = config.spendCapUsd;
	return {
		model,
		estTokens,
		estCompletionTokens,
		...(estCostUsd !== undefined ? { estCostUsd } : {}),
		...(capUsd ? { capUsd } : {}),
		overCap: Boolean(capUsd) && estCostUsd !== undefined && estCostUsd > capUsd!,
		...(limited ? { limitedToWords: wordsForTokens(request.replyLimit) } : {})
	};
}

export type SceneDraftResult =
	// The draft, its scene or its story is gone, or the draft was already
	// decided; nothing was asked.
	| { outcome: 'missing' }
	// The Assistant is off for the account or the story; nothing was asked.
	| { outcome: 'off' }
	// Earlier attempts of this job already spent the ceiling; nothing was asked.
	| { outcome: 'capped'; spentUsd: number }
	// The writer stopped it; the draft is discarded.
	| { outcome: 'stopped' }
	| { outcome: 'ready'; words: number; cutOff: boolean; capNotApplied?: string };

const UNSETTLED = ['pending', 'running'] as const;

// Moves a draft that is still being written to a settled state. A draft the
// writer already discarded is left alone. True when the row changed.
async function settleDraft(
	db: Database,
	draftId: string,
	set: { status: 'ready' | 'failed' | 'discarded'; note: string | null; textMd?: string }
): Promise<boolean> {
	const rows = await db
		.update(assistantDrafts)
		.set(set)
		.where(and(eq(assistantDrafts.id, draftId), inArray(assistantDrafts.status, UNSETTLED)))
		.returning({ id: assistantDrafts.id });
	return rows.length > 0;
}

// Marks a draft the job could not write as failed, with the reason the panel
// shows. For the worker, once no retry follows.
export async function failSceneDraft(db: Database, draftId: string, note: string): Promise<void> {
	await settleDraft(db, draftId, { status: 'failed', note });
}

// Writes one queued draft. Only the draft row is written: the scene is read,
// never changed. Throws when the request fails, leaving the draft unsettled so
// a retry of the job can write it; the worker settles it when none follows.
export async function runSceneDraft(
	db: Database,
	opts: { userId: string; draftId: string; jobId?: string; signal?: AbortSignal },
	deps: GatewayDeps = {}
): Promise<SceneDraftResult> {
	const { userId, draftId, signal } = opts;
	const [draft] = await db
		.select()
		.from(assistantDrafts)
		.where(
			and(
				eq(assistantDrafts.id, draftId),
				eq(assistantDrafts.userId, userId),
				inArray(assistantDrafts.status, UNSETTLED)
			)
		);
	if (!draft || !draft.sceneId) return { outcome: 'missing' };

	// Checked again here: the story may have been muted, or the Assistant
	// switched off, between the request and the job starting.
	const layout = await assistantLayout(db, userId, draft.storyId);
	if (!layout.surfacesEnabled) {
		await settleDraft(db, draftId, {
			status: 'failed',
			note: 'The Assistant is off for this story, so the draft was not written.'
		});
		return { outcome: 'off' };
	}

	const request = await sceneDraftRequest(db, {
		userId,
		storyId: draft.storyId,
		sceneId: draft.sceneId,
		brief: draft.brief,
		targetWords: draft.targetWords,
		pov: draft.pov
	});
	if (!request) {
		await settleDraft(db, draftId, {
			status: 'failed',
			note: 'The scene is no longer there, so the draft was not written.'
		});
		return { outcome: 'missing' };
	}

	// One request, but a job pg-boss retries sends it again: the meter carries
	// what earlier attempts spent.
	const meter = await jobSpendMeter(db, { userId, storyId: draft.storyId, jobId: opts.jobId });
	if (meter.capReached) {
		await settleDraft(db, draftId, {
			status: 'failed',
			note: 'This draft reached your spend cap before it was written. Raise the cap in your Assistant settings to try again.'
		});
		return { outcome: 'capped', spentUsd: meter.spentUsd };
	}

	await db
		.update(assistantDrafts)
		.set({ status: 'running' })
		.where(and(eq(assistantDrafts.id, draftId), eq(assistantDrafts.status, 'pending')));

	let result: Awaited<ReturnType<typeof completeDetailed>>;
	try {
		result = await completeDetailed(
			db,
			{
				userId,
				storyId: draft.storyId,
				role: 'coauthor',
				enableTools: false,
				messages: request.messages,
				maxTokens: request.maxTokens,
				meter,
				signal
			},
			deps
		);
	} catch (err) {
		// Stop ends the job for good, so the draft goes with it. Any other
		// abort (an expiry, a worker shutting down) is followed by a retry.
		if (stoppedByWriter(signal)) {
			await settleDraft(db, draftId, { status: 'discarded', note: DRAFT_STOPPED_NOTE });
			return { outcome: 'stopped' };
		}
		throw err;
	} finally {
		await meter.flush();
	}
	const text = result.content.trim();
	if (!text) throw new Error('The Assistant returned an empty draft.');

	// A draft cut off at the limit is kept: it is paid for, and most of a scene
	// is still worth reading. The note says it may end early.
	await settleDraft(db, draftId, {
		status: 'ready',
		textMd: text,
		note: result.cutOff ? DRAFT_CUT_OFF_NOTE : null
	});
	return {
		outcome: 'ready',
		words: wordCount(text),
		cutOff: result.cutOff === true,
		...(meter.notAppliedMessage ? { capNotApplied: meter.notAppliedMessage } : {})
	};
}
