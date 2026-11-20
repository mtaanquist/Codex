import { error, type RequestHandler } from '@sveltejs/kit';
import { db } from '#lib/server/db';
import { throwActionError } from '#lib/server/action-result';
import { queueSceneMentions, stopRunningAssistantJob } from '#lib/server/jobs';
import { addDraftAsScene, discardSceneDraft, fillSceneFromDraft } from '#lib/server/scene-drafts';
import { readJson } from '#lib/server/validation';
import { rateLimitWrites } from '#lib/server/write-guard';
import { MAX_DRAFT_WORDS } from '#lib/scene-draft';

// The writer's decision on a scene draft. 'fill' puts it into its own scene,
// only while that scene is empty; 'add' makes it a new scene after that one;
// 'discard' throws it away (stopping its job when it is still being written).
// There is no action that replaces a scene's text. text is the draft as the
// writer edited it in the panel.

// Far past the longest draft, so an edited draft still fits.
const MAX_TEXT_CHARS = MAX_DRAFT_WORDS * 20;

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) error(401, 'Sign in to decide a draft.');
	const userId = locals.user.id;
	rateLimitWrites(userId);
	const payload = await readJson<{ action?: unknown; text?: unknown }>(request);
	if (payload.text !== undefined && typeof payload.text !== 'string') {
		error(400, 'text must be a string.');
	}
	if (payload.text && payload.text.length > MAX_TEXT_CHARS) error(400, 'That draft is too long.');
	const draftId = params.id!;

	if (payload.action === 'fill') {
		const result = await fillSceneFromDraft(db, userId, draftId, payload.text);
		if (!result.ok) throwActionError(result);
		await queueSceneMentions(result.sceneId);
		return Response.json({ ok: true, sceneId: result.sceneId });
	}
	if (payload.action === 'add') {
		const result = await addDraftAsScene(db, userId, draftId, payload.text);
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
