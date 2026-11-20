import { error, type RequestHandler } from '@sveltejs/kit';
import { db } from '#lib/server/db';
import { throwActionError } from '#lib/server/action-result';
import { readAssistantPayload, requireAssistantStory } from '#lib/server/llm/assistant-route';
import { NoModelError } from '#lib/server/llm/gateway';
import { estimateSceneDraft, sceneDraftDefaults } from '#lib/server/llm/scene-draft';
import { assistantDraftJobState, queueAssistantDraft } from '#lib/server/jobs';
import { requestSceneDraft, sceneDraftFor } from '#lib/server/scene-drafts';
import { ownedScene } from '#lib/server/scene-access';
import { isUuid } from '#lib/slug';
import { clampDraftWords, MAX_DRAFT_BRIEF_CHARS, MAX_DRAFT_POV_CHARS } from '#lib/scene-draft';

// A scene draft: the Assistant writes one whole scene from the writer's brief.
// Only ever started here, by the writer's own request (the /draft command or
// "Draft this scene" on the scene's menu); nothing else queues one, and it is
// not a tool the model can call. The draft is written by a background job into
// its own staged row and reaches a scene only when the writer accepts it (see
// the [id] route). Refused when the Assistant is off for the account or the
// story.

const NO_MODEL = 'No model is chosen for Write. Pick one under Account, Assistant.';

// The draft the panel shows for a scene (being written, ready, or failed), or
// null when there is none.
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) error(401, 'Sign in to read a draft.');
	const story = await requireAssistantStory(locals.user.id, url.searchParams.get('storyId'));
	const sceneId = url.searchParams.get('sceneId') ?? '';
	const scene = isUuid(sceneId) ? await ownedScene(db, locals.user.id, sceneId) : null;
	if (!scene || scene.storyId !== story.id) error(404, 'Scene not found');
	return Response.json({
		draft: await sceneDraftFor(db, locals.user.id, scene.id, assistantDraftJobState)
	});
};

// With defaults: true, what the brief form opens with. With estimate: true,
// what the draft would send and cost; nothing is queued. Otherwise the draft is
// staged and its job queued.
export const POST: RequestHandler = async ({ request, locals }) => {
	const { userId, payload } = await readAssistantPayload<{
		storyId?: unknown;
		sceneId?: unknown;
		brief?: unknown;
		targetWords?: unknown;
		pov?: unknown;
		defaults?: unknown;
		estimate?: unknown;
	}>(request, locals);
	const story = await requireAssistantStory(userId, payload.storyId);
	const sceneId = typeof payload.sceneId === 'string' ? payload.sceneId : '';
	if (!isUuid(sceneId)) error(400, 'sceneId is required.');
	const scope = { userId, storyId: story.id, sceneId };

	const defaults = await sceneDraftDefaults(db, scope);
	if (!defaults) error(404, 'Scene not found');
	if (payload.defaults === true) return Response.json(defaults);

	const brief = typeof payload.brief === 'string' ? payload.brief.trim() : '';
	if (!brief) error(400, 'Say what should happen in the scene.');
	if (brief.length > MAX_DRAFT_BRIEF_CHARS) error(400, 'That brief is too long.');
	const pov = typeof payload.pov === 'string' ? payload.pov.trim() : '';
	if (pov.length > MAX_DRAFT_POV_CHARS) error(400, 'That point of view is too long.');
	if (payload.targetWords !== undefined && typeof payload.targetWords !== 'number') {
		error(400, 'The length must be a number of words.');
	}
	const input = {
		...scope,
		brief,
		targetWords: clampDraftWords(payload.targetWords ?? defaults.targetWords),
		pov: pov || null
	};

	try {
		if (payload.estimate === true) {
			const estimate = await estimateSceneDraft(db, input);
			if (!estimate) error(404, 'Scene not found');
			return Response.json(estimate);
		}
		const result = await requestSceneDraft(db, input, {
			queue: queueAssistantDraft,
			jobState: assistantDraftJobState
		});
		if (!result.ok) throwActionError(result);
		return Response.json({ ok: true, jobId: result.jobId, draftId: result.draftId });
	} catch (err) {
		if (err instanceof NoModelError) error(400, NO_MODEL);
		throw err;
	}
};
