import { error, json } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { stories } from '$lib/server/db/schema';
import { applySceneOrder, type SceneOrder } from '$lib/server/scene-order';

export const PUT: RequestHandler = async ({ params, request, locals }) => {
	const [story] = await db
		.select({ id: stories.id })
		.from(stories)
		.where(and(eq(stories.id, params.id), eq(stories.ownerId, locals.user!.id)));
	if (!story) error(404, 'Story not found');

	const payload = (await request.json()) as SceneOrder;
	if (!Array.isArray(payload?.chapters) || !Array.isArray(payload?.orphanSceneIds)) {
		error(400, 'order must have chapters and orphanSceneIds arrays');
	}

	const result = await applySceneOrder(db, story.id, payload);
	if (!result.ok) error(400, result.reason);
	return json({ ok: true });
};
