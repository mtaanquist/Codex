import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { rateLimitWrites } from '$lib/server/write-guard';
import { ownedStory } from '$lib/server/story-access';
import { mergeScenes } from '$lib/server/scene-split-merge';
import { queueSceneMentions } from '$lib/server/jobs';

// Merges the named scenes, in story order, into the earliest of them.
export const POST: RequestHandler = async ({ params, request, locals }) => {
	rateLimitWrites(locals.user!.id);
	const { story } = await ownedStory(params.id, locals.user!.id);
	const payload = (await request.json()) as { sceneIds?: unknown };
	const sceneIds = Array.isArray(payload.sceneIds)
		? payload.sceneIds.filter((id): id is string => typeof id === 'string')
		: [];
	const result = await mergeScenes(db, locals.user!.id, story.id, sceneIds);
	if (!result.ok) error(400, result.reason);
	await queueSceneMentions(result.targetSceneId);
	return json({ ok: true, targetSceneId: result.targetSceneId });
};
