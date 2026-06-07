import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { ownedStory } from '$lib/server/story-access';
import { duplicateScene } from '$lib/server/scene-split-merge';
import { queueSceneMentions } from '$lib/server/jobs';

// Duplicates a scene as a full copy directly after the original.
export const POST: RequestHandler = async ({ params, request, locals }) => {
	await ownedStory(params.id, locals.user!.id);
	const payload = (await request.json()) as { sceneId?: unknown };
	if (typeof payload.sceneId !== 'string') {
		error(400, 'sceneId must be a string');
	}
	const result = await duplicateScene(db, locals.user!.id, payload.sceneId);
	if (!result.ok) error(400, result.reason);
	await queueSceneMentions(result.newSceneId);
	return json({ ok: true, newSceneId: result.newSceneId });
};
