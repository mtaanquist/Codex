import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { deleteMarker, setMarkerResolved } from '$lib/server/markers';

// Checks a marker off (or back on).
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	const payload = (await request.json()) as { resolved?: unknown };
	if (typeof payload.resolved !== 'boolean') {
		error(400, 'resolved must be a boolean');
	}
	const updated = await setMarkerResolved(db, locals.user!.id, params.id, payload.resolved);
	if (!updated) error(404, 'marker not found');
	return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	const removed = await deleteMarker(db, locals.user!.id, params.id);
	if (!removed) error(404, 'marker not found');
	return json({ ok: true });
};
