import { error, type RequestHandler } from '@sveltejs/kit';
import { db } from '#lib/server/db';
import { throwActionError } from '#lib/server/action-result';
import { queueSceneMentions, stopRunningAssistantJob } from '#lib/server/jobs';
import {
	addDraftAsScene,
	discardSceneDraft,
	fillSceneFromDraft,
	saveDraftText
} from '#lib/server/scene-drafts';
import { MAX_BASE_HASHES } from '#lib/save-bases';
import { checkProseLength, readJson } from '#lib/server/validation';
import { rateLimitWrites } from '#lib/server/write-guard';

// The writer's decision on a scene draft. 'fill' puts it into its own scene,
// only while that scene is empty; 'add' makes it a new scene after that one;
// 'discard' throws it away (stopping its job when it is still being written).
// There is no action that replaces a scene's text. text is the draft as the
// writer edited it in the panel, held to the length a scene may be.
//
// Deciding or editing a staged draft sends nothing to the provider, so these
// need only the draft's owner: they work while the story is muted or the
// Assistant is off, so a draft already written is never stranded.

// Saves the writer's edits to a ready draft, so they outlive the panel. Only
// the draft row changes.
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) error(401, 'Sign in to edit a draft.');
	rateLimitWrites(locals.user.id);
	const payload = await readJson<{ text?: unknown; baseHashes?: unknown }>(request);
	if (typeof payload.text !== 'string') error(400, 'text must be a string.');
	checkText(payload.text);
	const result = await saveDraftText(
		db,
		locals.user.id,
		params.id!,
		payload.text,
		baseHashesOf(payload.baseHashes)
	);
	if (!result.ok) throwActionError(result);
	return Response.json({ ok: true });
};

// Fingerprints of the texts the writer's window has saved or may have saved
// (see save-bases), as the scene save takes them. Required: a save or a
// decision without them could replace text saved from another window.
function baseHashesOf(value: unknown): string[] {
	if (
		!Array.isArray(value) ||
		value.length === 0 ||
		value.length > MAX_BASE_HASHES ||
		!value.every((hash) => typeof hash === 'string' && hash.length <= 32)
	) {
		error(400, 'baseHashes must be a short list of strings.');
	}
	return value as string[];
}

// Postgres text cannot hold a null character, so it is refused here and not
// left to fail in the query.
function checkText(text: string): void {
	checkProseLength(text);
	if (text.includes('\u0000')) error(400, 'text must not contain a null character.');
}

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) error(401, 'Sign in to decide a draft.');
	const userId = locals.user.id;
	rateLimitWrites(userId);
	const payload = await readJson<{ action?: unknown; text?: unknown; baseHashes?: unknown }>(
		request
	);
	if (payload.text !== undefined && typeof payload.text !== 'string') {
		error(400, 'text must be a string.');
	}
	if (payload.text) checkText(payload.text);
	const draftId = params.id!;

	if (payload.action === 'fill') {
		const baseHashes = baseHashesOf(payload.baseHashes);
		const result = await fillSceneFromDraft(db, userId, draftId, payload.text, baseHashes);
		if (!result.ok) throwActionError(result);
		await queueSceneMentions(result.sceneId);
		return Response.json({ ok: true, sceneId: result.sceneId });
	}
	if (payload.action === 'add') {
		const baseHashes = baseHashesOf(payload.baseHashes);
		const result = await addDraftAsScene(db, userId, draftId, payload.text, baseHashes);
		if (!result.ok) throwActionError(result);
		await queueSceneMentions(result.newSceneId);
		return Response.json({ ok: true, newSceneId: result.newSceneId });
	}
	if (payload.action === 'discard') {
		const result = await discardSceneDraft(db, userId, draftId);
		if (!result.ok) throwActionError(result);
		if (result.stopJobId) await stopRunningAssistantJob(userId, result.stopJobId);
		return Response.json({ ok: true });
	}
	error(400, 'action must be fill, add or discard.');
};
