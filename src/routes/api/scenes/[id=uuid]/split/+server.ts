import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { rateLimitWrites } from '$lib/server/write-guard';
import { splitScene } from '$lib/server/scene-split-merge';
import { queueSceneMentions } from '$lib/server/jobs';

// Splits the scene at a character offset; the editor flushes its pending
// save first so the offset is against the stored text.
export const POST: RequestHandler = async ({ params, request, locals }) => {
	rateLimitWrites(locals.user!.id);
	const payload = (await request.json()) as { offset?: unknown };
	if (typeof payload.offset !== 'number') {
		error(400, 'offset must be a number');
	}
	const result = await splitScene(db, locals.user!.id, params.id, payload.offset);
	if (!result.ok) error(400, result.reason);
	await queueSceneMentions(params.id);
	await queueSceneMentions(result.newSceneId);
	return json({ ok: true, newSceneId: result.newSceneId });
};
