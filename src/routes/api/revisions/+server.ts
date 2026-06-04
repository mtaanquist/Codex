import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { createCheckpoint, type RevisionEntityType } from '$lib/server/revisions';

const REVISABLE = ['scene', 'character', 'place', 'lore_entry', 'outline_node'] as const;

// Creates a manual checkpoint of the entity's current text.
export const POST: RequestHandler = async ({ request, locals }) => {
	const payload = (await request.json()) as {
		entityType?: unknown;
		entityId?: unknown;
		label?: unknown;
	};
	if (
		!REVISABLE.includes(payload.entityType as (typeof REVISABLE)[number]) ||
		typeof payload.entityId !== 'string'
	) {
		error(400, 'entityType and entityId are required');
	}
	const result = await createCheckpoint(
		db,
		locals.user!.id,
		payload.entityType as RevisionEntityType,
		payload.entityId,
		typeof payload.label === 'string' ? payload.label : undefined
	);
	if (!result.ok) error(404, result.reason);
	return json({ ok: true }, { status: 201 });
};
