import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { declareMembership, removeMembership } from '$lib/server/membership';

// Declares or removes an entity's membership of the story, depending on
// the boolean in the payload.
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	const payload = (await request.json()) as {
		kind?: unknown;
		entityId?: unknown;
		member?: unknown;
	};
	if (
		(payload.kind !== 'character' && payload.kind !== 'place') ||
		typeof payload.entityId !== 'string' ||
		typeof payload.member !== 'boolean'
	) {
		error(400, 'kind, entityId and member are required');
	}
	const result = payload.member
		? await declareMembership(db, locals.user!.id, payload.kind, payload.entityId, params.id)
		: await removeMembership(db, locals.user!.id, payload.kind, payload.entityId, params.id);
	if (!result.ok) error(404, result.reason);
	return json({ ok: true });
};
