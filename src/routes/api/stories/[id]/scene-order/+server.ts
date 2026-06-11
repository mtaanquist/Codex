import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { ownedStory } from '$lib/server/story-access';
import { applySceneOrder, type SceneOrder } from '$lib/server/scene-order';
import { readJson } from '$lib/server/validation';
import { rateLimitWrites } from '$lib/server/write-guard';

export const PUT: RequestHandler = async ({ params, request, locals }) => {
	rateLimitWrites(locals.user!.id);
	const { story } = await ownedStory(params.id, locals.user!.id);

	const payload = await readJson<SceneOrder>(request);
	if (!Array.isArray(payload?.chapters) || !Array.isArray(payload?.orphanSceneIds)) {
		error(400, 'order must have chapters and orphanSceneIds arrays');
	}

	const result = await applySceneOrder(db, story.id, payload);
	if (!result.ok) error(400, result.reason);
	return json({ ok: true });
};
