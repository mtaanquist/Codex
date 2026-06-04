import { error, json } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { stories } from '$lib/server/db/schema';
import { applyOutlineOrder } from '$lib/server/outline';

// Reorders one sibling group of the story's outline.
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	const [story] = await db
		.select({ id: stories.id })
		.from(stories)
		.where(and(eq(stories.id, params.id), eq(stories.ownerId, locals.user!.id)));
	if (!story) error(404, 'Story not found');

	const payload = (await request.json()) as { parentId?: unknown; order?: unknown };
	const parentId = typeof payload.parentId === 'string' ? payload.parentId : null;
	if (!Array.isArray(payload.order) || payload.order.some((id) => typeof id !== 'string')) {
		error(400, 'order must be an array of node ids');
	}

	const result = await applyOutlineOrder(db, story.id, parentId, payload.order as string[]);
	if (!result.ok) error(400, result.reason);
	return json({ ok: true });
};
