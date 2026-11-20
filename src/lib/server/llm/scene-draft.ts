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
	PREVIOUS_DRAFT_CHARS,
	wordsForTokens,
	type ChapterDraftEstimate,
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
export const CHAPTER_DRAFT_ENDED_NOTE =
	'The chapter draft ended before it reached this scene, so it was not drafted.';
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

// What a chapter draft adds to one scene's request.
type ChapterContext = {
	chapterBrief: string;
	// The scene drafted just before this one, when there is one.
	previousDraft: string | null;
	// The writer's brief for each scene the run drafts, by scene id.
	plans: Map<string, string>;
};

// The closing part of a drafted scene, as the next scene's request carries it.
function draftTail(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length <= PREVIOUS_DRAFT_CHARS) return trimmed;
	return '[...] ' + trimmed.slice(trimmed.length - PREVIOUS_DRAFT_CHARS).trimStart();
}

// The scene after this one in story order, as the draft is told about it: the
// writer's plan for it when the same chapter draft writes it next, else its
// summary when that is usable, else how it opens.
async function followingScene(db: Database, scene: DraftScene, plans?: Map<string, string>) {
	const [next] = await db
		.select({
			id: scenes.id,
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
	const plan = plans?.get(next.id)?.trim();
	if (plan) return { title: next.title, text: plan, kind: 'plan' as const };
	const summary = usableSceneSummary(next);
	if (summary) return { title: next.title, text: summary, kind: 'summary' as const };
	const opening = bodyExcerpt(next.bodyMd, FOLLOWING_OPENING_CHARS);
	return opening ? { title: next.title, text: opening, kind: 'opening' as const } : null;
}

// The request a draft would send as things stand, and what bounds its reply.
// Null when the scene is not the user's. Throws NoModelError when no model is
// chosen for the role.
async function sceneDraftRequest(db: Database, input: SceneDraftInput, chapter?: ChapterContext) {
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
		focusText: input.brief || chapter?.chapterBrief || '',
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
			following: await followingScene(db, scene, chapter?.plans),
			chapterBrief: chapter?.chapterBrief,
			previousDraft: chapter?.previousDraft ? draftTail(chapter.previousDraft) : null
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
	return priceDraft(request, requestTokens(request), 1, input.targetWords);
}

type DraftRequest = NonNullable<Awaited<ReturnType<typeof sceneDraftRequest>>>;

function requestTokens(request: DraftRequest): number {
	return (
		PERSONA_TOKENS +
		request.messages.reduce((sum, message) => sum + estimateTokens(message.content), 0)
	);
}

// The estimate for `scenes` requests of one length that send estTokens between
// them, priced and held against the cap as one job.
function priceDraft(
	request: DraftRequest,
	estTokens: number,
	sceneCount: number,
	targetWords: number
): SceneDraftEstimate {
	const { config, model } = request;
	const expected = draftExpectedTokens(targetWords);
	const limited = request.replyLimit < expected;
	const estCompletionTokens = (limited ? request.replyLimit : expected) * sceneCount;
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

export type ChapterDraftInput = {
	userId: string;
	storyId: string;
	// What the writer said about the chapter as a whole; may be empty when
	// every scene has its own brief.
	brief: string;
	targetWords: number;
	pov?: string | null;
	// The scenes to draft, in the order they are drafted.
	scenes: { sceneId: string; brief: string }[];
};

/**
 * What a chapter draft would send and cost: the sum of its scenes' requests,
 * each later one carrying the scene drafted before it. Scenes that are not the
 * user's are left out; null when none is left. Throws NoModelError when no
 * model is chosen.
 */
export async function estimateChapterDraft(
	db: Database,
	input: ChapterDraftInput
): Promise<Omit<ChapterDraftEstimate, 'skipped'> | null> {
	const plans = new Map(input.scenes.map((scene) => [scene.sceneId, scene.brief]));
	// The scene before is not written yet, so it is counted at the length asked
	// for, up to how much of it rides along.
	const carried = Math.min(
		draftExpectedTokens(input.targetWords),
		estimateTokens('x'.repeat(PREVIOUS_DRAFT_CHARS))
	);
	let first: DraftRequest | null = null;
	let estTokens = 0;
	let count = 0;
	for (const scene of input.scenes) {
		const request = await sceneDraftRequest(
			db,
			{ ...input, sceneId: scene.sceneId, brief: scene.brief },
			{ chapterBrief: input.brief, previousDraft: null, plans }
		);
		if (!request) continue;
		estTokens += requestTokens(request) + (count > 0 ? carried : 0);
		first ??= request;
		count += 1;
	}
	if (!first) return null;
	return { ...priceDraft(first, estTokens, count, input.targetWords), scenes: count };
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

export type ChapterDraftResult =
	// None of the drafts is there to write any more; nothing was asked.
	| { outcome: 'missing' }
	| {
			outcome: 'done';
			// Scenes with a draft ready, out of the scenes asked for.
			drafted: number;
			total: number;
			words: number;
			// Drafts that stopped at the length limit.
			cutOff: number;
			// Scenes that were deleted or moved to the trash before their turn.
			gone: number;
			// Why the run ended before the last scene, when it did.
			ended?: 'stopped' | 'capped' | 'off';
			spentUsd: number;
			capNotApplied?: string;
	  };

// Discards the drafts of a run that are still unsettled, when the run ends
// before reaching them.
async function discardRest(db: Database, draftIds: string[]): Promise<void> {
	await db
		.update(assistantDrafts)
		.set({ status: 'discarded', note: CHAPTER_DRAFT_ENDED_NOTE })
		.where(and(inArray(assistantDrafts.id, draftIds), inArray(assistantDrafts.status, UNSETTLED)));
}

/**
 * Ends a chapter draft the job could not finish, once no retry follows: the
 * scene it was on is marked failed with the reason, and the scenes after it
 * are discarded. Drafts already written stay ready. Returns how many are.
 */
export async function failChapterDraft(
	db: Database,
	userId: string,
	draftIds: string[],
	note: string
): Promise<{ drafted: number; total: number }> {
	const rows = await db
		.select({ id: assistantDrafts.id, status: assistantDrafts.status })
		.from(assistantDrafts)
		.where(and(inArray(assistantDrafts.id, draftIds), eq(assistantDrafts.userId, userId)));
	const status = new Map(rows.map((row) => [row.id, row.status]));
	const current = draftIds.find((id) => {
		const state = status.get(id);
		return state === 'pending' || state === 'running';
	});
	if (current) await settleDraft(db, current, { status: 'failed', note });
	await discardRest(
		db,
		rows.map((row) => row.id)
	);
	const drafted = rows.filter((row) => row.status === 'ready' || row.status === 'accepted').length;
	return { drafted, total: draftIds.length };
}

/**
 * Writes a chapter's queued drafts, one request per scene in order, each told
 * what the scene before it was drafted as. Only the draft rows are written.
 * Before each scene it checks the writer's Stop, that the Assistant is still on
 * for the story, and the spend cap; any of them ends the run at that scene
 * boundary, keeping the drafts already written and discarding the rest. A
 * scene that is gone by its turn is left out. Throws when a request fails,
 * leaving that scene and the ones after it unsettled so a retry of the job
 * carries on from there; the worker ends the run when no retry follows.
 */
export async function runChapterDraft(
	db: Database,
	opts: {
		userId: string;
		storyId: string;
		brief: string;
		draftIds: string[];
		jobId?: string;
		signal?: AbortSignal;
	},
	deps: GatewayDeps = {}
): Promise<ChapterDraftResult> {
	const { userId, storyId, draftIds, signal } = opts;
	const mine = (id: string) => and(eq(assistantDrafts.id, id), eq(assistantDrafts.userId, userId));
	const rows = draftIds.length
		? await db
				.select({
					id: assistantDrafts.id,
					sceneId: assistantDrafts.sceneId,
					brief: assistantDrafts.brief,
					status: assistantDrafts.status
				})
				.from(assistantDrafts)
				.where(
					and(
						inArray(assistantDrafts.id, draftIds),
						eq(assistantDrafts.userId, userId),
						eq(assistantDrafts.storyId, storyId)
					)
				)
		: [];
	if (!rows.some((row) => row.status === 'pending' || row.status === 'running')) {
		return { outcome: 'missing' };
	}
	const known = new Set(rows.map((row) => row.id));
	const plans = new Map(rows.flatMap((row) => (row.sceneId ? [[row.sceneId, row.brief]] : [])));

	const meter = await jobSpendMeter(db, { userId, storyId, jobId: opts.jobId });
	let previousDraft: string | null = null;
	let drafted = 0;
	let words = 0;
	let cutOff = 0;
	let gone = 0;
	let ended: 'stopped' | 'capped' | 'off' | undefined;

	for (const draftId of draftIds) {
		if (!known.has(draftId)) continue;
		// Read fresh: the writer may have discarded this scene's draft meanwhile,
		// and an earlier attempt of the job may already have written it.
		const [draft] = await db.select().from(assistantDrafts).where(mine(draftId));
		if (!draft || !draft.sceneId) continue;
		if (draft.status === 'ready' || draft.status === 'accepted') {
			drafted += 1;
			words += wordCount(draft.textMd);
			if (draft.note === DRAFT_CUT_OFF_NOTE) cutOff += 1;
			previousDraft = draft.textMd;
			continue;
		}
		if (draft.status !== 'pending' && draft.status !== 'running') {
			previousDraft = null;
			continue;
		}

		if (stoppedByWriter(signal)) {
			ended = 'stopped';
			break;
		}
		// Checked before every scene: the story may be muted, or the Assistant
		// switched off, while the run is under way.
		const layout = await assistantLayout(db, userId, storyId);
		if (!layout.surfacesEnabled) {
			ended = 'off';
			break;
		}
		if (meter.capReached) {
			ended = 'capped';
			break;
		}

		const request = await sceneDraftRequest(
			db,
			{
				userId,
				storyId,
				sceneId: draft.sceneId,
				brief: draft.brief,
				targetWords: draft.targetWords,
				pov: draft.pov
			},
			{ chapterBrief: opts.brief, previousDraft, plans }
		);
		if (!request) {
			await settleDraft(db, draftId, {
				status: 'discarded',
				note: 'The scene is no longer there, so it was not drafted.'
			});
			gone += 1;
			previousDraft = null;
			continue;
		}

		await db
			.update(assistantDrafts)
			.set({ status: 'running' })
			.where(and(mine(draftId), eq(assistantDrafts.status, 'pending')));

		let result: Awaited<ReturnType<typeof completeDetailed>>;
		try {
			result = await completeDetailed(
				db,
				{
					userId,
					storyId,
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
			// The scene being written when Stop lands is dropped whole; the ones
			// before it are kept.
			if (stoppedByWriter(signal)) {
				ended = 'stopped';
				break;
			}
			throw err;
		} finally {
			await meter.flush();
		}
		const text = result.content.trim();
		if (!text) throw new Error('The Assistant returned an empty draft.');

		// A draft the writer discarded while it was being written stays discarded.
		const kept = await settleDraft(db, draftId, {
			status: 'ready',
			textMd: text,
			note: result.cutOff ? DRAFT_CUT_OFF_NOTE : null
		});
		if (!kept) {
			previousDraft = null;
			continue;
		}
		drafted += 1;
		words += wordCount(text);
		if (result.cutOff) cutOff += 1;
		previousDraft = text;
	}

	if (ended) await discardRest(db, [...known]);
	return {
		outcome: 'done',
		drafted,
		total: draftIds.length,
		words,
		cutOff,
		gone,
		...(ended ? { ended } : {}),
		spentUsd: meter.spentUsd,
		...(meter.notAppliedMessage ? { capNotApplied: meter.notAppliedMessage } : {})
	};
}
