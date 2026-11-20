import { error, type RequestHandler } from '@sveltejs/kit';
import { db } from '#lib/server/db';
import { throwActionError } from '#lib/server/action-result';
import { readAssistantPayload, requireAssistantStory } from '#lib/server/llm/assistant-route';
import { NoModelError } from '#lib/server/llm/gateway';
import { ownedStory } from '#lib/server/story-access';
import { assistantDraftJobState, queueAssistantChapterDraft } from '#lib/server/jobs';
import {
	CHAPTER_HAS_NO_SCENES,
	chapterDraftDefaults,
	chapterDraftEstimate,
	chapterDraftFor,
	requestChapterDraft
} from '#lib/server/scene-drafts';
import { isUuid } from '#lib/slug';
import { clampDraftWords, MAX_DRAFT_BRIEF_CHARS, MAX_DRAFT_POV_CHARS } from '#lib/scene-draft';

// A chapter draft: the Assistant drafts the chapter's scenes one by one, each
// into its own staged scene draft. Like a scene draft it is only ever started
// here, by the writer's own request (the /draft-chapter command or "Draft this
// chapter" on the chapter's menu), and it is not a tool the model can call.
// Each drafted scene is kept or discarded on its own through the scene draft
// route. Asking and counting are refused when the Assistant is off for the
// account or the story; reading the staged drafts back needs only their owner.

const NO_MODEL = 'No model is chosen for Write. Pick one under Account, Assistant.';

// The chapter's drafts that are being written or waiting for the writer, or
// null when there are none.
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) error(401, 'Sign in to read a draft.');
	const { story } = await ownedStory(url.searchParams.get('storyId') ?? '', locals.user.id);
	const chapterId = url.searchParams.get('chapterId') ?? '';
	if (!isUuid(chapterId)) error(404, 'Chapter not found');
	return Response.json({
		run: await chapterDraftFor(
			db,
			{ userId: locals.user.id, storyId: story.id, chapterId },
			assistantDraftJobState
		)
	});
};

// With defaults: true, what the brief form opens with. With estimate: true,
// what the draft would send and cost; nothing is queued. Otherwise the drafts
// are staged and their job queued.
export const POST: RequestHandler = async ({ request, locals }) => {
	const { userId, payload } = await readAssistantPayload<{
		storyId?: unknown;
		chapterId?: unknown;
		brief?: unknown;
		targetWords?: unknown;
		pov?: unknown;
		scenes?: unknown;
		defaults?: unknown;
		estimate?: unknown;
	}>(request, locals);
	const story = await requireAssistantStory(userId, payload.storyId);
	const chapterId = typeof payload.chapterId === 'string' ? payload.chapterId : '';
	if (!isUuid(chapterId)) error(400, 'chapterId is required.');
	const scope = { userId, storyId: story.id, chapterId };

	const defaults = await chapterDraftDefaults(db, scope, assistantDraftJobState);
	if (!defaults) error(404, 'Chapter not found');
	if (defaults.scenes.length === 0) error(400, CHAPTER_HAS_NO_SCENES);
	if (payload.defaults === true) return Response.json(defaults);

	const brief = typeof payload.brief === 'string' ? payload.brief.trim() : '';
	if (brief.length > MAX_DRAFT_BRIEF_CHARS) error(400, 'That brief is too long.');
	const pov = typeof payload.pov === 'string' ? payload.pov.trim() : '';
	if (pov.length > MAX_DRAFT_POV_CHARS) error(400, 'That point of view is too long.');
	if (payload.targetWords !== undefined && typeof payload.targetWords !== 'number') {
		error(400, 'The length must be a number of words.');
	}
	if (!Array.isArray(payload.scenes)) error(400, 'Choose at least one scene to draft.');
	const scenes: { sceneId: string; brief: string }[] = [];
	for (const entry of payload.scenes as unknown[]) {
		const scene = entry as { sceneId?: unknown; brief?: unknown } | null;
		if (!scene || typeof scene.sceneId !== 'string' || !isUuid(scene.sceneId)) {
			error(400, 'Each scene needs its id.');
		}
		const sceneBrief = typeof scene.brief === 'string' ? scene.brief.trim() : '';
		if (sceneBrief.length > MAX_DRAFT_BRIEF_CHARS) error(400, 'A scene brief is too long.');
		scenes.push({ sceneId: scene.sceneId, brief: sceneBrief });
	}
	const input = {
		...scope,
		brief,
		targetWords: clampDraftWords(payload.targetWords ?? defaults.targetWords),
		pov: pov || null,
		scenes
	};

	try {
		if (payload.estimate === true) {
			const result = await chapterDraftEstimate(db, input, assistantDraftJobState);
			if (!result.ok) throwActionError(result);
			return Response.json(result.estimate);
		}
		const result = await requestChapterDraft(db, input, {
			queue: queueAssistantChapterDraft,
			jobState: assistantDraftJobState
		});
		if (!result.ok) throwActionError(result);
		return Response.json({
			ok: true,
			jobId: result.jobId,
			draftIds: result.draftIds,
			skipped: result.skipped
		});
	} catch (err) {
		if (err instanceof NoModelError) error(400, NO_MODEL);
		throw err;
	}
};
