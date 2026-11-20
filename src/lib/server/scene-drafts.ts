import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { ActionFailure } from './action-result';
import type { Database } from './auth';
import { isUniqueViolation } from './db-errors';
import { assistantDrafts, scenes } from './db/schema';
import { recordRevision } from './revisions';
import { ownedScene } from './scene-access.ts';
import { saveSceneBody } from './scene-save';
import { lockStoryScene, makeRoomAfter } from './scene-split-merge';
import { inLiveStory } from './universe-scope.ts';
import { DRAFT_STOPPED_NOTE, estimateSceneDraft, type SceneDraftInput } from './llm/scene-draft.ts';
import { isUuid } from '#lib/slug';
import { textHash } from '#lib/text-hash';
import { wordCount } from '#lib/word-count';
import type { SceneDraftView } from '#lib/scene-draft';

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
const NOT_READY: ActionFailure = {
	ok: false,
	code: 'conflict',
	reason: 'That draft is not ready to use.'
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
export type DraftJobState = (jobId: string) => Promise<'running' | 'stopped' | 'done' | 'failed'>;

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
	if (!jobState || !draft.jobId) return false;
	const state = await jobState(draft.jobId);
	if (state === 'running') return false;
	const rows = await db
		.update(assistantDrafts)
		.set(
			state === 'stopped'
				? { status: 'discarded', note: DRAFT_STOPPED_NOTE }
				: { status: 'failed', note: DRAFT_DID_NOT_FINISH }
		)
		.where(
			and(eq(assistantDrafts.id, draft.id), inArray(assistantDrafts.status, ['pending', 'running']))
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
		sceneTitle: title?.title ?? null
	};
}

export type QueueSceneDraft = (job: {
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
			reason: `This draft is estimated at about $${estimate.estCostUsd!.toFixed(2)}, over your spend cap of $${estimate.capUsd!.toFixed(2)}, so it was not started. Ask for a shorter scene, or raise the cap in your Assistant settings.`
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
			jobId: assistantDrafts.jobId
		})
		.from(assistantDrafts)
		.where(and(mine, inArray(assistantDrafts.status, OPEN)));
	for (const draft of open) {
		if (!(await settleOrphan(db, draft, deps.jobState))) return ALREADY_DRAFTING;
	}
	// A failed draft has been read by now; the new request takes its place.
	await db
		.update(assistantDrafts)
		.set({ status: 'discarded' })
		.where(and(mine, eq(assistantDrafts.status, 'failed')));

	let draftId: string;
	try {
		const [row] = await db
			.insert(assistantDrafts)
			.values({
				userId: input.userId,
				storyId: input.storyId,
				sceneId: input.sceneId,
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

	const jobId = await deps.queue({
		userId: input.userId,
		storyId: input.storyId,
		sceneId: input.sceneId,
		draftId
	});
	if (!jobId || jobId === 'coalesced') {
		// Nothing will write it, so it must not hold the scene.
		await db.delete(assistantDrafts).where(eq(assistantDrafts.id, draftId));
		return jobId === 'coalesced'
			? ALREADY_DRAFTING
			: {
					ok: false,
					code: 'conflict',
					reason: 'Could not start the draft. Try again in a moment.'
				};
	}
	await db.update(assistantDrafts).set({ jobId }).where(eq(assistantDrafts.id, draftId));
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

// The text the writer accepts: the draft as they edited it in the panel, or
// the stored draft when they changed nothing.
function acceptedText(edited: string | undefined, stored: string): string {
	return (edited ?? stored).trim();
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
	edited?: string
): Promise<{ ok: true; sceneId: string } | ActionFailure> {
	const draft = await ownedDraft(db, userId, draftId);
	if (!draft || !draft.sceneId) return NOT_FOUND;
	if (draft.status !== 'ready') return NOT_READY;
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
		if (!ready) return NOT_READY;
		if (scene.bodyMd.trim() !== '') return SCENE_HAS_TEXT;
		const text = acceptedText(edited, ready.textMd);
		if (!text) return EMPTY;

		// The base fingerprint is of the text read under the lock, so the save
		// goes through only over exactly that (empty) text.
		const saved = await saveSceneBody(tx, sceneId, {
			title: scene.title,
			bodyMd: text,
			anchors: null,
			baseHashes: [textHash(scene.bodyMd)],
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
	edited?: string
): Promise<{ ok: true; newSceneId: string } | ActionFailure> {
	const draft = await ownedDraft(db, userId, draftId);
	if (!draft || !draft.sceneId) return NOT_FOUND;
	if (draft.status !== 'ready') return NOT_READY;
	const sceneId = draft.sceneId;
	const owned = await ownedScene(db, userId, sceneId);
	if (!owned) return SCENE_GONE;

	return await db.transaction(async (tx) => {
		const scene = await lockStoryScene(tx, owned.storyId, sceneId);
		if (!scene) return SCENE_GONE;
		const ready = await lockReadyDraft(tx, userId, draftId);
		if (!ready) return NOT_READY;
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
	if (rows.length === 0) return NOT_READY;
	const unsettled = draft.status === 'pending' || draft.status === 'running';
	return { ok: true, stopJobId: unsettled ? draft.jobId : null };
}
