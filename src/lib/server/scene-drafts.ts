import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, notInArray, sql } from 'drizzle-orm';
import type { ActionFailure } from './action-result';
import type { Database } from './auth';
import { isUniqueViolation } from './db-errors';
import { assistantDrafts, chapters, scenes, stories } from './db/schema';
import { recordRevision } from './revisions';
import { ownedScene } from './scene-access.ts';
import { saveSceneBody } from './scene-save';
import { lockStoryScene, makeRoomAfter } from './scene-split-merge';
import { inLiveStory, storyIsLive } from './universe-scope.ts';
import { usableSceneSummary } from './summary-currency.ts';
import {
	DRAFT_STOPPED_NOTE,
	estimateChapterDraft,
	estimateSceneDraft,
	type SceneDraftInput
} from './llm/scene-draft.ts';
import { isUuid } from '#lib/slug';
import { textHash } from '#lib/text-hash';
import { wordCount } from '#lib/word-count';
import {
	chapterCapAdvice,
	defaultDraftWords,
	DRAFT_CHANGED_ELSEWHERE,
	DRAFT_DECIDED_ELSEWHERE,
	DRAFT_NOT_WRITTEN,
	DRAFT_EMPTY_SAVE,
	isBlankDraft,
	sceneCapAdvice,
	type ChapterDraftDefaults,
	type ChapterDraftEstimate,
	type ChapterDraftView,
	type SceneDraftView,
	type WaitingDraft
} from '#lib/scene-draft';

// The writer's side of a scene draft: asking for one, reading it back, and
// deciding it. A draft reaches the story only here, and only two ways: into
// its own scene while that scene is still empty, or as a new scene after it.
// Nothing here replaces prose the writer has. Every query is scoped to the
// user who asked for the draft.

const NOT_FOUND: ActionFailure = {
	ok: false,
	code: 'not_found',
	reason: 'That draft is no longer there.'
};
// Why a draft that is not ready cannot be edited or kept: it was decided
// already, or was never written (still under way, or failed).
function notReady(status: string | undefined): ActionFailure {
	if (status === undefined) return NOT_FOUND;
	const decided = status === 'accepted' || status === 'discarded';
	return {
		ok: false,
		code: 'conflict',
		reason: decided ? DRAFT_DECIDED_ELSEWHERE : DRAFT_NOT_WRITTEN
	};
}
const CHANGED: ActionFailure = {
	ok: false,
	code: 'conflict',
	reason: DRAFT_CHANGED_ELSEWHERE
};
const EMPTY_SAVE: ActionFailure = {
	ok: false,
	code: 'invalid',
	reason: DRAFT_EMPTY_SAVE
};
const EMPTY: ActionFailure = {
	ok: false,
	code: 'invalid',
	reason: 'The draft is empty, so there is nothing to add.'
};
const SCENE_GONE: ActionFailure = {
	ok: false,
	code: 'not_found',
	reason: 'That scene no longer exists.'
};
export const SCENE_HAS_TEXT: ActionFailure = {
	ok: false,
	code: 'conflict',
	reason:
		'This scene has text in it now, so the draft was not put into it. Add the draft as a new scene instead.'
};
const ALREADY_DRAFTING: ActionFailure = {
	ok: false,
	code: 'conflict',
	reason: 'This scene already has a draft. Keep it or discard it before asking for another.'
};
export const DRAFT_DID_NOT_FINISH = 'This draft did not finish. Ask for it again.';

// The states a draft is still in front of the writer in: being written, ready
// to decide, or failed with a reason to read.
const SHOWN = ['pending', 'running', 'ready', 'failed'] as const;
const OPEN = ['pending', 'running', 'ready'] as const;

// What the queue says about a draft's job: still going, stopped by the writer,
// or settled either way.
export type DraftJobState = (
	jobId: string
) => Promise<'running' | 'stopped' | 'done' | 'failed' | 'missing'>;

// A draft's row is written just before its job is queued, so for a moment the
// queue does not know the job. Only after this long is a job the queue cannot
// find taken as one that was never queued.
const QUEUE_GRACE_MS = 60_000;

// A draft whose job ended without settling the draft: stopped (the worker
// notices a Stop only at its next heartbeat, and never for a job still
// queued), or dropped by the queue. It is settled here so it stops holding
// the scene: a stopped one is discarded, any other is marked failed. A draft
// the job did settle is left as it is. Whatever the job writes afterwards is
// dropped, since it only settles a draft that is still unsettled.
async function settleOrphan(
	db: Database,
	draft: { id: string; status: string; jobId: string | null },
	jobState: DraftJobState | undefined
): Promise<boolean> {
	if (draft.status !== 'pending' && draft.status !== 'running') return false;
	if (!jobState) return false;
	// Every row is written with its job's id. One without (from before that)
	// has nothing to write it once the grace has passed.
	const state = draft.jobId ? await jobState(draft.jobId) : 'missing';
	if (state === 'running') return false;
	const rows = await db
		.update(assistantDrafts)
		.set(
			state === 'stopped'
				? { status: 'discarded', note: DRAFT_STOPPED_NOTE }
				: { status: 'failed', note: DRAFT_DID_NOT_FINISH }
		)
		.where(
			and(
				eq(assistantDrafts.id, draft.id),
				inArray(assistantDrafts.status, ['pending', 'running']),
				// A job the queue does not know may only not be queued yet. The
				// row's age is taken on the database's clock, which stamped it.
				state === 'missing'
					? sql`${assistantDrafts.createdAt} < now() - make_interval(secs => ${QUEUE_GRACE_MS / 1000})`
					: undefined
			)
		)
		.returning({ id: assistantDrafts.id });
	return rows.length > 0;
}

// The draft the panel shows for a scene: the one being written or waiting to
// be decided, else the latest that failed. Null when there is none, or the
// scene is not the user's.
export async function sceneDraftFor(
	db: Database,
	userId: string,
	sceneId: string,
	jobState?: DraftJobState
): Promise<SceneDraftView | null> {
	if (!isUuid(sceneId)) return null;
	const scene = await ownedScene(db, userId, sceneId);
	if (!scene) return null;
	const read = () =>
		db
			.select()
			.from(assistantDrafts)
			.where(
				and(
					eq(assistantDrafts.userId, userId),
					eq(assistantDrafts.sceneId, sceneId),
					inArray(assistantDrafts.status, SHOWN)
				)
			)
			.orderBy(desc(assistantDrafts.createdAt))
			.limit(1);
	let [draft] = await read();
	if (!draft) return null;
	if (await settleOrphan(db, draft, jobState)) [draft] = await read();
	if (!draft) return null;
	const [title] = await db
		.select({ title: scenes.title })
		.from(scenes)
		.where(eq(scenes.id, sceneId));
	return {
		id: draft.id,
		sceneId,
		status: draft.status,
		brief: draft.brief,
		targetWords: draft.targetWords,
		pov: draft.pov,
		textMd: draft.textMd,
		note: draft.note,
		jobId: draft.jobId,
		createdAt: draft.createdAt.toISOString(),
		sceneEmpty: scene.bodyMd.trim() === '',
		sceneTitle: title?.title ?? null,
		// position marks a draft of a chapter run; it outlives the chapter.
		inChapterRun: draft.position !== null
	};
}

// jobId is the id the queued job must take: it is already on the draft's row.
export type QueueSceneDraft = (job: {
	jobId: string;
	userId: string;
	storyId: string;
	sceneId: string;
	draftId: string;
}) => Promise<string | 'coalesced' | null>;

// Stages a new draft for a scene and queues the job that writes it. Refused
// when the estimate is over the spend cap, and when the scene already has a
// draft the writer has not decided. The caller has checked the Assistant is on
// for the story. Throws NoModelError when no model is chosen.
export async function requestSceneDraft(
	db: Database,
	input: SceneDraftInput,
	deps: { queue: QueueSceneDraft; jobState?: DraftJobState }
): Promise<{ ok: true; draftId: string; jobId: string } | ActionFailure> {
	const estimate = await estimateSceneDraft(db, input);
	if (!estimate) return SCENE_GONE;
	if (estimate.overCap) {
		return {
			ok: false,
			code: 'conflict',
			reason: `This draft is estimated at up to $${estimate.estCostUsd!.toFixed(2)}, over your spend cap of $${estimate.capUsd!.toFixed(2)}, so it was not started. ${sceneCapAdvice(estimate.mayThink)}`
		};
	}

	const mine = and(
		eq(assistantDrafts.userId, input.userId),
		eq(assistantDrafts.sceneId, input.sceneId)
	);
	const open = await db
		.select({
			id: assistantDrafts.id,
			status: assistantDrafts.status,
			jobId: assistantDrafts.jobId,
			createdAt: assistantDrafts.createdAt
		})
		.from(assistantDrafts)
		.where(and(mine, inArray(assistantDrafts.status, OPEN)));
	for (const draft of open) {
		if (!(await settleOrphan(db, draft, deps.jobState))) return ALREADY_DRAFTING;
	}
	// The job's id is chosen here and written with the row, so a row never
	// waits without one: if the request dies before the job is queued, reading
	// the draft finds no such job and settles it (see settleOrphan).
	const jobId = randomUUID();
	let draftId: string;
	try {
		const [row] = await db
			.insert(assistantDrafts)
			.values({
				userId: input.userId,
				storyId: input.storyId,
				sceneId: input.sceneId,
				jobId,
				brief: input.brief,
				targetWords: input.targetWords,
				pov: input.pov?.trim() || null
			})
			.returning({ id: assistantDrafts.id });
		draftId = row.id;
	} catch (err) {
		// A second request for the same scene landed first.
		if (isUniqueViolation(err)) return ALREADY_DRAFTING;
		throw err;
	}

	const queued = await deps.queue({
		jobId,
		userId: input.userId,
		storyId: input.storyId,
		sceneId: input.sceneId,
		draftId
	});
	if (!queued || queued === 'coalesced') {
		// Nothing will write it, so it must not hold the scene.
		await db.delete(assistantDrafts).where(eq(assistantDrafts.id, draftId));
		return queued === 'coalesced'
			? ALREADY_DRAFTING
			: {
					ok: false,
					code: 'conflict',
					reason: 'Could not start the draft. Try again in a moment.'
				};
	}
	// A failed draft has been read by now, and the new request takes its
	// place. Only once the new one stands, so the reason the old one failed is
	// not lost to a request that did not go through; and after the insert, so
	// the scene's row is always locked before a draft's (as a scene delete
	// takes them). Never the new one: its job may have failed already, and the
	// writer has not read why.
	await db
		.update(assistantDrafts)
		.set({ status: 'discarded' })
		.where(and(mine, eq(assistantDrafts.status, 'failed'), ne(assistantDrafts.id, draftId)));
	return { ok: true, draftId, jobId };
}

// The user's draft, whatever state it is in; null when it is not theirs.
async function ownedDraft(db: Database, userId: string, draftId: string) {
	if (!isUuid(draftId)) return null;
	const [draft] = await db
		.select()
		.from(assistantDrafts)
		.where(and(eq(assistantDrafts.id, draftId), eq(assistantDrafts.userId, userId)));
	return draft ?? null;
}

// The draft row, locked, when it is still ready to be decided. Taken after the
// scene rows: deleting a scene removes its drafts in that order too.
async function lockReadyDraft(tx: Database, userId: string, draftId: string) {
	const [draft] = await tx
		.select({ id: assistantDrafts.id, textMd: assistantDrafts.textMd })
		.from(assistantDrafts)
		.where(
			and(
				eq(assistantDrafts.id, draftId),
				eq(assistantDrafts.userId, userId),
				eq(assistantDrafts.status, 'ready')
			)
		)
		.for('update');
	return draft ?? null;
}

// Whether the stored draft is other than the window acting on it knows: not
// one of the texts it has saved or may have saved (see save-bases), and not
// the text it is sending now (a save of that text that landed with its answer
// lost). Without a list nothing is checked.
function changedElsewhere(
	stored: string,
	edited: string | undefined,
	baseHashes?: string[]
): boolean {
	return baseHashes !== undefined && stored !== edited && !baseHashes.includes(textHash(stored));
}

// The text the writer accepts: the draft as they edited it in the panel, or
// the stored draft when they changed nothing.
function acceptedText(edited: string | undefined, stored: string): string {
	const text = (edited ?? stored).trim();
	return isBlankDraft(text) ? '' : text;
}

/**
 * Puts a ready draft into its own scene, only while that scene has no prose.
 * The check and the write share one transaction under the scene's row lock,
 * so text that reached the scene after the draft was made (another window, a
 * save still on its way) is never replaced: the draft stays ready and the
 * writer is told. The write is the ordinary scene save, so it lands in History
 * like any edit.
 */
export async function fillSceneFromDraft(
	db: Database,
	userId: string,
	draftId: string,
	edited?: string,
	// The version of the draft the writer was looking at; a draft saved from
	// another window since is not decided from the older copy.
	baseHashes?: string[]
): Promise<{ ok: true; sceneId: string } | ActionFailure> {
	const draft = await ownedDraft(db, userId, draftId);
	if (!draft || !draft.sceneId) return NOT_FOUND;
	if (draft.status !== 'ready') return notReady(draft.status);
	const sceneId = draft.sceneId;
	if (!(await ownedScene(db, userId, sceneId))) return SCENE_GONE;

	return await db.transaction(async (tx) => {
		const [scene] = await tx
			.select({ bodyMd: scenes.bodyMd, title: scenes.title })
			.from(scenes)
			.where(and(eq(scenes.id, sceneId), isNull(scenes.deletedAt), inLiveStory(scenes.storyId)))
			.for('update');
		if (!scene) return SCENE_GONE;
		const ready = await lockReadyDraft(tx, userId, draftId);
		if (!ready) return notReady((await ownedDraft(tx, userId, draftId))?.status);
		if (changedElsewhere(ready.textMd, edited, baseHashes)) return CHANGED;
		if (scene.bodyMd.trim() !== '') return SCENE_HAS_TEXT;
		const text = acceptedText(edited, ready.textMd);
		if (!text) return EMPTY;

		// The base fingerprint is of an empty scene (or of the blank lines read
		// under the lock), never of prose: the save itself refuses to go over
		// any text, whatever the check above let through.
		const saved = await saveSceneBody(tx, sceneId, {
			title: scene.title,
			bodyMd: text,
			anchors: null,
			baseHashes: [...new Set([textHash(''), textHash(scene.bodyMd.trim() ? '' : scene.bodyMd)])],
			overwrite: false
		});
		// The save refuses before it writes anything, so nothing is half applied.
		if (!saved.ok) return 'missing' in saved ? SCENE_GONE : SCENE_HAS_TEXT;
		await tx
			.update(assistantDrafts)
			.set({ status: 'accepted', textMd: text })
			.where(eq(assistantDrafts.id, draftId));
		return { ok: true as const, sceneId };
	});
}

/**
 * Adds a ready draft as a new scene directly after the one it was drafted
 * for, with the status Draft. The scene it was drafted for is not changed.
 * Returns the new scene's id; the caller queues its mention rebuild.
 */
export async function addDraftAsScene(
	db: Database,
	userId: string,
	draftId: string,
	edited?: string,
	// The version of the draft the writer was looking at; a draft saved from
	// another window since is not decided from the older copy.
	baseHashes?: string[]
): Promise<{ ok: true; newSceneId: string } | ActionFailure> {
	const draft = await ownedDraft(db, userId, draftId);
	if (!draft || !draft.sceneId) return NOT_FOUND;
	if (draft.status !== 'ready') return notReady(draft.status);
	const sceneId = draft.sceneId;
	const owned = await ownedScene(db, userId, sceneId);
	if (!owned) return SCENE_GONE;

	return await db.transaction(async (tx) => {
		const scene = await lockStoryScene(tx, owned.storyId, sceneId);
		if (!scene) return SCENE_GONE;
		const ready = await lockReadyDraft(tx, userId, draftId);
		if (!ready) return notReady((await ownedDraft(tx, userId, draftId))?.status);
		if (changedElsewhere(ready.textMd, edited, baseHashes)) return CHANGED;
		const text = acceptedText(edited, ready.textMd);
		if (!text) return EMPTY;

		const created = await makeRoomAfter(tx, scene, {
			title: null,
			bodyMd: text,
			status: 'draft',
			wordCount: wordCount(text)
		});
		await recordRevision(tx, 'scene', created, text);
		await tx
			.update(assistantDrafts)
			.set({ status: 'accepted', textMd: text })
			.where(eq(assistantDrafts.id, draftId));
		return { ok: true as const, newSceneId: created };
	});
}

/**
 * Discards a draft: one that is ready or failed, or one still being written
 * (the caller stops its job). Returns the job to stop, if it has one running.
 */
export async function discardSceneDraft(
	db: Database,
	userId: string,
	draftId: string
): Promise<{ ok: true; stopJobId: string | null } | ActionFailure> {
	const draft = await ownedDraft(db, userId, draftId);
	if (!draft) return NOT_FOUND;
	const rows = await db
		.update(assistantDrafts)
		.set({ status: 'discarded' })
		.where(
			and(
				eq(assistantDrafts.id, draftId),
				eq(assistantDrafts.userId, userId),
				inArray(assistantDrafts.status, SHOWN)
			)
		)
		.returning({ id: assistantDrafts.id });
	// Already accepted or discarded: nothing to do, and nothing to undo.
	if (rows.length === 0) return notReady('discarded');
	const unsettled = draft.status === 'pending' || draft.status === 'running';
	// One scene of a chapter draft: its job has other scenes to write, and
	// passes over this one now that it is discarded.
	return { ok: true, stopJobId: unsettled && draft.position === null ? draft.jobId : null };
}

/**
 * Saves the writer's edits to a draft that is waiting to be decided, so they
 * outlive the panel. Only the draft row changes, and only while it is ready:
 * a draft already kept or discarded is left as it was.
 */
export async function saveDraftText(
	db: Database,
	userId: string,
	draftId: string,
	text: string,
	// Fingerprints of the texts the window saving has saved or may have saved.
	// When the stored text is none of them (it was saved from another window),
	// the save is refused.
	baseHashes?: string[]
): Promise<{ ok: true } | ActionFailure> {
	if (!isUuid(draftId)) return NOT_FOUND;
	// A draft is paid for and has no history: it is dropped by Discard, never
	// by a save that would leave it blank.
	if (isBlankDraft(text)) return EMPTY_SAVE;
	return await db.transaction(async (tx) => {
		const ready = await lockReadyDraft(tx, userId, draftId);
		if (!ready) return notReady((await ownedDraft(tx, userId, draftId))?.status);
		if (changedElsewhere(ready.textMd, text, baseHashes)) return CHANGED;
		if (ready.textMd !== text) {
			await tx.update(assistantDrafts).set({ textMd: text }).where(eq(assistantDrafts.id, draftId));
		}
		return { ok: true as const };
	});
}

// ---- A chapter, drafted scene by scene ----
// One job writes a draft row per scene, in order. Each row is an ordinary
// scene draft once written: the writer keeps or discards it on its own, with
// the functions above.

const CHAPTER_GONE: ActionFailure = {
	ok: false,
	code: 'not_found',
	reason: 'That chapter no longer exists.'
};
const ALREADY_DRAFTING_CHAPTER: ActionFailure = {
	ok: false,
	code: 'conflict',
	reason: 'This chapter is already being drafted. Wait for it to finish, or stop it first.'
};

export const CHAPTER_HAS_NO_SCENES =
	'This chapter has no scenes yet. Add a scene for each part of the chapter, then ask again.';

// A chapter of a live story of the user's, with its live scenes in order.
async function chapterScenes(db: Database, userId: string, storyId: string, chapterId: string) {
	if (!isUuid(chapterId)) return null;
	const [chapter] = await db
		.select({ id: chapters.id, title: chapters.title })
		.from(chapters)
		.innerJoin(stories, eq(chapters.storyId, stories.id))
		.where(
			and(
				eq(chapters.id, chapterId),
				eq(chapters.storyId, storyId),
				eq(stories.ownerId, userId),
				storyIsLive()
			)
		);
	if (!chapter) return null;
	const rows = await db
		.select({
			id: scenes.id,
			title: scenes.title,
			bodyMd: scenes.bodyMd,
			summaryMd: scenes.summaryMd,
			summaryGeneratedAt: scenes.summaryGeneratedAt,
			updatedAt: scenes.updatedAt
		})
		.from(scenes)
		.where(and(eq(scenes.chapterId, chapterId), isNull(scenes.deletedAt)))
		.orderBy(asc(scenes.globalPosition));
	return { chapter, scenes: rows };
}

// Asks the queue about each job once, however many drafts it writes.
function onceEach(jobState: DraftJobState | undefined): DraftJobState | undefined {
	if (!jobState) return undefined;
	const asked = new Map<string, ReturnType<DraftJobState>>();
	return (jobId) => {
		let state = asked.get(jobId);
		if (!state) asked.set(jobId, (state = jobState(jobId)));
		return state;
	};
}

/**
 * True when the writer has a draft in this story still to keep or discard.
 * The story page asks while the Assistant is off, to keep the panel there
 * for the drafts written before.
 */
export async function hasWaitingDrafts(
	db: Database,
	userId: string,
	storyId: string,
	jobState?: DraftJobState
): Promise<boolean> {
	return (await waitingDrafts(db, userId, storyId, jobState)).length > 0;
}

/**
 * The writer's undecided drafts in a story, in story order: written and
 * waiting, failed, or still being written (shown so they can be stopped).
 */
export async function waitingDrafts(
	db: Database,
	userId: string,
	storyId: string,
	jobState?: DraftJobState
): Promise<WaitingDraft[]> {
	// A draft whose job is gone is settled first, as a read of its scene
	// would, so it is not listed as being written for ever.
	if (jobState) {
		const open = await db
			.select({
				id: assistantDrafts.id,
				status: assistantDrafts.status,
				jobId: assistantDrafts.jobId
			})
			.from(assistantDrafts)
			.where(
				and(
					eq(assistantDrafts.userId, userId),
					eq(assistantDrafts.storyId, storyId),
					inArray(assistantDrafts.status, ['pending', 'running'])
				)
			);
		const state = onceEach(jobState);
		for (const draft of open) await settleOrphan(db, draft, state);
	}
	// By the scene's own story, and only scenes still in it: a draft whose
	// scene is in the trash, or has moved to another story, cannot be reached
	// from this one. One row a scene, its newest: a failed draft and the one
	// asked for in its place can both be undecided for a moment.
	const rows = await db
		.selectDistinctOn([scenes.id], {
			sceneId: scenes.id,
			sceneTitle: scenes.title,
			status: assistantDrafts.status,
			position: scenes.globalPosition
		})
		.from(assistantDrafts)
		.innerJoin(scenes, eq(scenes.id, assistantDrafts.sceneId))
		.where(
			and(
				eq(assistantDrafts.userId, userId),
				eq(scenes.storyId, storyId),
				isNull(scenes.deletedAt),
				inArray(assistantDrafts.status, ['pending', 'running', 'ready', 'failed'])
			)
		)
		.orderBy(scenes.id, desc(assistantDrafts.createdAt));
	return rows
		.sort((a, b) => a.position - b.position)
		.map(({ sceneId, sceneTitle, status }) => ({ sceneId, sceneTitle, status }));
}

// The scenes among these with a draft the writer has not decided, after
// settling any whose job is gone.
async function undecidedScenes(
	db: Database,
	userId: string,
	sceneIds: string[],
	jobState: DraftJobState | undefined
): Promise<Set<string>> {
	const held = new Set<string>();
	if (sceneIds.length === 0) return held;
	const open = await db
		.select({
			id: assistantDrafts.id,
			sceneId: assistantDrafts.sceneId,
			status: assistantDrafts.status,
			jobId: assistantDrafts.jobId,
			createdAt: assistantDrafts.createdAt
		})
		.from(assistantDrafts)
		.where(
			and(
				eq(assistantDrafts.userId, userId),
				inArray(assistantDrafts.sceneId, sceneIds),
				inArray(assistantDrafts.status, OPEN)
			)
		);
	const state = onceEach(jobState);
	for (const draft of open) {
		if (draft.sceneId && !(await settleOrphan(db, draft, state))) held.add(draft.sceneId);
	}
	return held;
}

// What the chapter brief form opens with: every scene of the chapter with its
// summary as its brief (the writer's, or the Assistant's while it still tells
// the scene). Null when the chapter is not the user's.
export async function chapterDraftDefaults(
	db: Database,
	opts: { userId: string; storyId: string; chapterId: string },
	jobState?: DraftJobState
): Promise<ChapterDraftDefaults | null> {
	const found = await chapterScenes(db, opts.userId, opts.storyId, opts.chapterId);
	if (!found) return null;
	const held = await undecidedScenes(
		db,
		opts.userId,
		found.scenes.map((scene) => scene.id),
		jobState
	);
	const counts = await db
		.select({ wordCount: scenes.wordCount })
		.from(scenes)
		.where(and(eq(scenes.storyId, opts.storyId), isNull(scenes.deletedAt)));
	return {
		chapterTitle: found.chapter.title,
		targetWords: defaultDraftWords(counts.map((row) => row.wordCount)),
		scenes: found.scenes.map((scene) => ({
			sceneId: scene.id,
			title: scene.title,
			brief: usableSceneSummary(scene) ?? '',
			hasText: scene.bodyMd.trim() !== '',
			hasDraft: held.has(scene.id)
		}))
	};
}

export type ChapterDraftRequest = {
	userId: string;
	storyId: string;
	chapterId: string;
	brief: string;
	targetWords: number;
	pov?: string | null;
	// The scenes the writer chose, each with its own brief (which may be empty
	// when the chapter brief covers it).
	scenes: { sceneId: string; brief: string }[];
};

// Which of the chosen scenes a chapter draft would write, in chapter order,
// and which it leaves out because they already have an undecided draft.
async function planChapterDraft(
	db: Database,
	input: ChapterDraftRequest,
	jobState: DraftJobState | undefined
): Promise<
	| {
			ok: true;
			scenes: { sceneId: string; brief: string }[];
			skipped: { sceneId: string; title: string | null }[];
	  }
	| ActionFailure
> {
	const found = await chapterScenes(db, input.userId, input.storyId, input.chapterId);
	if (!found) return CHAPTER_GONE;
	if (found.scenes.length === 0) {
		return { ok: false, code: 'invalid', reason: CHAPTER_HAS_NO_SCENES };
	}
	const asked = new Map(input.scenes.map((scene) => [scene.sceneId, scene.brief.trim()]));
	const chosen = found.scenes.filter((scene) => asked.has(scene.id));
	if (chosen.length === 0) {
		return { ok: false, code: 'invalid', reason: 'Choose at least one scene to draft.' };
	}
	if (!input.brief.trim() && chosen.some((scene) => !asked.get(scene.id))) {
		return {
			ok: false,
			code: 'invalid',
			reason: 'Say what happens in the chapter, or in each scene you chose.'
		};
	}
	const held = await undecidedScenes(
		db,
		input.userId,
		chosen.map((scene) => scene.id),
		jobState
	);
	const scenesToDraft = chosen
		.filter((scene) => !held.has(scene.id))
		.map((scene) => ({ sceneId: scene.id, brief: asked.get(scene.id) ?? '' }));
	if (scenesToDraft.length === 0) {
		return {
			ok: false,
			code: 'conflict',
			reason:
				'Every scene you chose already has a draft. Keep or discard those drafts before asking for more.'
		};
	}
	return {
		ok: true,
		scenes: scenesToDraft,
		skipped: chosen
			.filter((scene) => held.has(scene.id))
			.map((scene) => ({ sceneId: scene.id, title: scene.title }))
	};
}

// What the chapter draft would send and cost, counted without sending
// anything. Throws NoModelError when no model is chosen.
export async function chapterDraftEstimate(
	db: Database,
	input: ChapterDraftRequest,
	jobState?: DraftJobState
): Promise<{ ok: true; estimate: ChapterDraftEstimate } | ActionFailure> {
	const plan = await planChapterDraft(db, input, jobState);
	if (!plan.ok) return plan;
	const estimate = await estimateChapterDraft(db, { ...input, scenes: plan.scenes });
	if (!estimate) return CHAPTER_GONE;
	return { ok: true, estimate: { ...estimate, skipped: plan.skipped } };
}

export type QueueChapterDraft = (job: {
	jobId: string;
	userId: string;
	storyId: string;
	chapterId: string;
	draftIds: string[];
	brief: string;
}) => Promise<string | 'coalesced' | null>;

/**
 * Stages a draft for each chosen scene of a chapter and queues the one job
 * that writes them in order. A scene that already has an undecided draft is
 * left out and named in the result. Refused when the summed estimate is over
 * the spend cap. The caller has checked the Assistant is on for the story.
 * Throws NoModelError when no model is chosen.
 */
export async function requestChapterDraft(
	db: Database,
	input: ChapterDraftRequest,
	deps: { queue: QueueChapterDraft; jobState?: DraftJobState }
): Promise<
	| {
			ok: true;
			jobId: string;
			draftIds: string[];
			skipped: { sceneId: string; title: string | null }[];
	  }
	| ActionFailure
> {
	const plan = await planChapterDraft(db, input, deps.jobState);
	if (!plan.ok) return plan;
	const estimate = await estimateChapterDraft(db, { ...input, scenes: plan.scenes });
	if (!estimate) return CHAPTER_GONE;
	if (estimate.overCap) {
		return {
			ok: false,
			code: 'conflict',
			reason: `This chapter draft is estimated at up to $${estimate.estCostUsd!.toFixed(2)}, over your spend cap of $${estimate.capUsd!.toFixed(2)}, so it was not started. ${chapterCapAdvice(estimate.mayThink)}`
		};
	}

	const sceneIds = plan.scenes.map((scene) => scene.sceneId);
	// Written with the rows, as for a single draft (see requestSceneDraft).
	const jobId = randomUUID();
	let draftIds: string[];
	try {
		{
			const rows = await db
				.insert(assistantDrafts)
				.values(
					plan.scenes.map((scene, index) => ({
						userId: input.userId,
						storyId: input.storyId,
						chapterId: input.chapterId,
						sceneId: scene.sceneId,
						jobId,
						position: index,
						brief: scene.brief,
						targetWords: input.targetWords,
						pov: input.pov?.trim() || null
					}))
				)
				.returning({ id: assistantDrafts.id, position: assistantDrafts.position });
			draftIds = rows.sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map((row) => row.id);
		}
	} catch (err) {
		// A draft for one of the scenes was asked for at the same moment.
		if (isUniqueViolation(err)) return ALREADY_DRAFTING_CHAPTER;
		throw err;
	}

	const queued = await deps.queue({
		jobId,
		userId: input.userId,
		storyId: input.storyId,
		chapterId: input.chapterId,
		draftIds,
		brief: input.brief.trim()
	});
	if (!queued || queued === 'coalesced') {
		// Nothing will write them, so they must not hold their scenes.
		await db.delete(assistantDrafts).where(inArray(assistantDrafts.id, draftIds));
		return queued === 'coalesced'
			? ALREADY_DRAFTING_CHAPTER
			: {
					ok: false,
					code: 'conflict',
					reason: 'Could not start the draft. Try again in a moment.'
				};
	}
	// The failed drafts these take the place of, as for a single draft (see
	// requestSceneDraft): after the insert, and only once the run is queued.
	await db
		.update(assistantDrafts)
		.set({ status: 'discarded' })
		.where(
			and(
				eq(assistantDrafts.userId, input.userId),
				inArray(assistantDrafts.sceneId, sceneIds),
				eq(assistantDrafts.status, 'failed'),
				notInArray(assistantDrafts.id, draftIds)
			)
		);
	return { ok: true, jobId, draftIds, skipped: plan.skipped };
}

/**
 * The chapter's scene drafts that came from a chapter draft and are still in
 * front of the writer (being written, ready, or failed), in chapter order.
 * Null when there are none, or the chapter is not the user's.
 */
export async function chapterDraftFor(
	db: Database,
	opts: { userId: string; storyId: string; chapterId: string },
	jobState?: DraftJobState
): Promise<ChapterDraftView | null> {
	const found = await chapterScenes(db, opts.userId, opts.storyId, opts.chapterId);
	if (!found) return null;
	const read = () =>
		db
			.select()
			.from(assistantDrafts)
			.where(
				and(
					eq(assistantDrafts.userId, opts.userId),
					eq(assistantDrafts.chapterId, opts.chapterId),
					isNotNull(assistantDrafts.sceneId),
					inArray(assistantDrafts.status, SHOWN)
				)
			)
			.orderBy(desc(assistantDrafts.createdAt));
	let rows = await read();
	const state = onceEach(jobState);
	let settled = false;
	for (const row of rows) settled = (await settleOrphan(db, row, state)) || settled;
	if (settled) rows = await read();

	// The newest draft of each scene, for the scenes still in the chapter.
	const latest = new Map<string, (typeof rows)[number]>();
	for (const row of rows) if (!latest.has(row.sceneId!)) latest.set(row.sceneId!, row);
	const listed = found.scenes.flatMap((scene) => {
		const row = latest.get(scene.id);
		return row
			? [
					{
						draftId: row.id,
						sceneId: scene.id,
						sceneTitle: scene.title,
						status: row.status,
						note: row.note,
						jobId: row.jobId
					}
				]
			: [];
	});
	if (listed.length === 0) return null;
	const writing = listed.find((row) => row.status === 'pending' || row.status === 'running');
	return {
		chapterId: opts.chapterId,
		chapterTitle: found.chapter.title,
		jobId: writing?.jobId ?? null,
		scenes: listed.map((row) => ({
			draftId: row.draftId,
			sceneId: row.sceneId,
			sceneTitle: row.sceneTitle,
			status: row.status,
			note: row.note
		}))
	};
}

// How far a chapter draft's job has got, for the activity center: scenes
// settled out of scenes asked for. Null for a job that is not a chapter draft
// of the user's.
export async function chapterDraftProgress(
	db: Database,
	userId: string,
	jobId: string
): Promise<{ completed: number; total: number } | null> {
	const rows = await db
		.select({ status: assistantDrafts.status })
		.from(assistantDrafts)
		.where(
			and(
				eq(assistantDrafts.jobId, jobId),
				eq(assistantDrafts.userId, userId),
				// Set on a chapter run's drafts, and kept if the chapter is deleted.
				isNotNull(assistantDrafts.position)
			)
		);
	if (rows.length === 0) return null;
	const waiting = rows.filter((row) => row.status === 'pending' || row.status === 'running');
	return { completed: rows.length - waiting.length, total: rows.length };
}
