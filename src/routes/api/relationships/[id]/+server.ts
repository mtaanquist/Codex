import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { deleteRelationship } from '$lib/server/relationships';

export const DELETE: RequestHandler = async ({ params, locals }) => {
	const removed = await deleteRelationship(db, params.id, locals.user!.id);
	if (!removed) error(404, 'relationship not found');
	return json({ ok: true });
};
