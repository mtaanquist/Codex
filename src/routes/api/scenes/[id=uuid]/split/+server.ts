import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '#lib/server/db';
import { throwActionError } from '#lib/server/action-result';
import { rateLimitWrites } from '#lib/server/write-guard';
import { locateSplitInStory, splitScene } from '#lib/server/scene-split-merge';
import { queueSceneMentions } from '#lib/server/jobs';
import { readJson } from '#lib/server/validation';

// Splits the scene either at a character offset (the editor flushes its
// pending save first so the offset is against the stored text) or at the
// start of an exact passage (`before`, the Assistant's proposal path) that is
// re-located against the stored text here, so edits since the proposal cannot
// misplace the cut. The passage may have moved into another scene of the
// story (confirming an earlier proposal splits the later ones away); the
// locate follows it, so the split lands on whichever scene holds it now.
// Either way the split is refused when the text changes before it lands.
export const POST: RequestHandler = async ({ params, request, locals }) => {
	rateLimitWrites(locals.user!.id);
	const payload = await readJson<{ offset?: unknown; before?: unknown; baseHash?: unknown }>(
		request
	);

	let targetSceneId = params.id;
	let offset: number;
	let baseHash: string | undefined;
	if (typeof payload.before === 'string') {
		const location = await locateSplitInStory(db, locals.user!.id, params.id, payload.before);
		if (!location.ok) throwActionError(location);
		targetSceneId = location.sceneId;
		offset = location.offset;
		baseHash = location.baseHash;
	} else if (typeof payload.offset === 'number') {
		offset = payload.offset;
		if (payload.baseHash !== undefined) {
			if (typeof payload.baseHash !== 'string' || payload.baseHash.length > 32) {
				error(400, 'baseHash must be a short string');
			}
			baseHash = payload.baseHash;
		}
	} else {
		error(400, 'offset must be a number');
	}

	const result = await splitScene(db, locals.user!.id, targetSceneId, offset, baseHash);
	if (!result.ok) throwActionError(result);
	await queueSceneMentions(targetSceneId);
	await queueSceneMentions(result.newSceneId);
	// splitSceneId names the scene that was actually cut, which the locate may
	// have re-targeted away from the requested one.
	return Response.json({ ok: true, newSceneId: result.newSceneId, splitSceneId: targetSceneId });
};
