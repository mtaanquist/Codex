import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { deleteOutlineNode, saveOutlineNode } from '$lib/server/outline';

// Debounced autosave target for the outline node editor.
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	const payload = (await request.json()) as {
		title?: unknown;
		bodyMd?: unknown;
		linkedSceneId?: unknown;
		linkedChapterId?: unknown;
	};
	if (typeof payload.title !== 'string' || typeof payload.bodyMd !== 'string') {
		error(400, 'title and bodyMd must be strings');
	}
	const result = await saveOutlineNode(db, params.id, locals.user!.id, {
		title: payload.title,
		bodyMd: payload.bodyMd,
		linkedSceneId: typeof payload.linkedSceneId === 'string' ? payload.linkedSceneId : null,
		linkedChapterId: typeof payload.linkedChapterId === 'string' ? payload.linkedChapterId : null
	});
	if (!result.ok) {
		error(result.reason.includes('not found') ? 404 : 400, result.reason);
	}
	return json({ savedAt: new Date().toISOString() });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	const removed = await deleteOutlineNode(db, params.id, locals.user!.id);
	if (!removed) error(404, 'outline node not found');
	return json({ ok: true });
};
