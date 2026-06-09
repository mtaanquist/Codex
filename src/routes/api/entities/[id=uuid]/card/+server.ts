import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { getEntityCard } from '$lib/server/plan-data';

// The read-only entity card shown in the editor's right column. Owner-scoped:
// a foreign or unknown id is a 404, never another author's entity.
export const GET: RequestHandler = async ({ params, locals }) => {
	const card = await getEntityCard(db, locals.user!.id, params.id);
	if (!card) error(404, 'Not found');
	return json(card);
};
