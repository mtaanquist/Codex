import { error, json } from '@sveltejs/kit';
import { throwActionError } from '$lib/server/action-result';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { createMarker } from '$lib/server/markers';

// Turns the editor's current selection into a checkable marker.
export const POST: RequestHandler = async ({ params, request, locals }) => {
	const payload = (await request.json()) as {
		anchorStart?: unknown;
		anchorEnd?: unknown;
		bodyMd?: unknown;
	};
	if (typeof payload.anchorStart !== 'number' || typeof payload.anchorEnd !== 'number') {
		error(400, 'anchorStart and anchorEnd must be numbers');
	}
	const result = await createMarker(
		db,
		locals.user!.id,
		params.id,
		payload.anchorStart,
		payload.anchorEnd,
		typeof payload.bodyMd === 'string' ? payload.bodyMd : undefined
	);
	if (!result.ok) {
		throwActionError(result);
	}
	return json({ id: result.id }, { status: 201 });
};
