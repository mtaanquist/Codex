import { error, json } from '@sveltejs/kit';
import { and, eq, isNull } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { scenes, stories } from '$lib/server/db/schema';
import { rateLimitWrites } from '$lib/server/write-guard';
import { splitScene } from '$lib/server/scene-split-merge';
import { locateSplitBefore } from '$lib/scene-split-locate';
import { queueSceneMentions } from '$lib/server/jobs';

// Splits the scene either at a character offset (the editor flushes its
// pending save first so the offset is against the stored text) or at the
// start of an exact passage (`before`, the Assistant's proposal path) that is
// re-located against the stored text here, so edits since the proposal cannot
// misplace the cut.
export const POST: RequestHandler = async ({ params, request, locals }) => {
	rateLimitWrites(locals.user!.id);
	const payload = (await request.json()) as { offset?: unknown; before?: unknown };

	let offset: number;
	if (typeof payload.before === 'string') {
		const [scene] = await db
			.select({ bodyMd: scenes.bodyMd })
			.from(scenes)
			.innerJoin(stories, eq(scenes.storyId, stories.id))
			.where(
				and(
					eq(scenes.id, params.id),
					eq(stories.ownerId, locals.user!.id),
					isNull(scenes.deletedAt)
				)
			);
		if (!scene) error(404, 'scene not found');
		const location = locateSplitBefore(scene.bodyMd, payload.before);
		if (!location.ok) error(400, location.reason);
		offset = location.offset;
	} else if (typeof payload.offset === 'number') {
		offset = payload.offset;
	} else {
		error(400, 'offset must be a number');
	}

	const result = await splitScene(db, locals.user!.id, params.id, offset);
	if (!result.ok) error(400, result.reason);
	await queueSceneMentions(params.id);
	await queueSceneMentions(result.newSceneId);
	return json({ ok: true, newSceneId: result.newSceneId });
};
