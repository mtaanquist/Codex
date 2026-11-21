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
	const payload = await readJson<{ text?: unknown; base?: unknown; sent?: unknown }>(request);
	if (typeof payload.text !== 'string') error(400, 'text must be a string.');
	checkText(payload.text);
	if (payload.sent !== undefined && typeof payload.sent !== 'string') {
		error(400, 'sent must be a string.');
	}
	if (payload.sent) checkText(payload.sent);
	const result = await saveDraftText(
		db,
		locals.user.id,
		params.id!,
		payload.text,
		baseOf(payload.base),
		payload.sent
	);
	if (!result.ok) throwActionError(result);
	return Response.json({ ok: true, textVersion: result.textVersion });
};

// The version of the draft the writer's copy was made from. Required: a save
// or a decision without it could replace text saved from another window.
function baseOf(value: unknown): string {
	if (typeof value !== 'string' || !/^[0-9a-f]{32}$/.test(value)) {
		error(400, 'base must be a draft version.');
	}
	return value;
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
	const payload = await readJson<{ action?: unknown; text?: unknown; base?: unknown }>(request);
	if (payload.text !== undefined && typeof payload.text !== 'string') {
		error(400, 'text must be a string.');
	}
	if (payload.text) checkText(payload.text);
	const draftId = params.id!;

	if (payload.action === 'fill') {
		const base = baseOf(payload.base);
		const result = await fillSceneFromDraft(db, userId, draftId, payload.text, base);
		if (!result.ok) throwActionError(result);
		await queueSceneMentions(result.sceneId);
		return Response.json({ ok: true, sceneId: result.sceneId });
	}
	if (payload.action === 'add') {
		const base = baseOf(payload.base);
		const result = await addDraftAsScene(db, userId, draftId, payload.text, base);
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
