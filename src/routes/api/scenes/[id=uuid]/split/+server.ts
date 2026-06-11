import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { rateLimitWrites } from '$lib/server/write-guard';
import { locateSplitInStory, splitScene } from '$lib/server/scene-split-merge';
import { queueSceneMentions } from '$lib/server/jobs';

// Splits the scene either at a character offset (the editor flushes its
// pending save first so the offset is against the stored text) or at the
// start of an exact passage (`before`, the Assistant's proposal path) that is
// re-located against the stored text here, so edits since the proposal cannot
// misplace the cut. The passage may have moved into another scene of the
// story (confirming an earlier proposal splits the later ones away); the
// locate follows it, so the split lands on whichever scene holds it now.
export const POST: RequestHandler = async ({ params, request, locals }) => {
	rateLimitWrites(locals.user!.id);
	const payload = (await request.json()) as { offset?: unknown; before?: unknown };

	let targetSceneId = params.id;
	let offset: number;
	if (typeof payload.before === 'string') {
		const location = await locateSplitInStory(db, locals.user!.id, params.id, payload.before);
		if (!location.ok) {
			error(location.reason === 'scene not found' ? 404 : 400, location.reason);
		}
		targetSceneId = location.sceneId;
		offset = location.offset;
	} else if (typeof payload.offset === 'number') {
		offset = payload.offset;
	} else {
		error(400, 'offset must be a number');
	}

	const result = await splitScene(db, locals.user!.id, targetSceneId, offset);
	if (!result.ok) error(400, result.reason);
	await queueSceneMentions(targetSceneId);
	await queueSceneMentions(result.newSceneId);
	// splitSceneId names the scene that was actually cut, which the locate may
	// have re-targeted away from the requested one.
	return json({ ok: true, newSceneId: result.newSceneId, splitSceneId: targetSceneId });
};
