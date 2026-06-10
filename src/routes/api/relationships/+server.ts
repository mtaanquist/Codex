import { error, json } from '@sveltejs/kit';
import { throwActionError } from '$lib/server/action-result';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { rateLimitWrites } from '$lib/server/write-guard';
import { createRelationship } from '$lib/server/relationships';

const KINDS = ['character', 'place', 'lore'] as const;

export const POST: RequestHandler = async ({ request, locals }) => {
	rateLimitWrites(locals.user!.id);
	const payload = (await request.json()) as {
		fromKind?: unknown;
		fromId?: unknown;
		relationTypeId?: unknown;
		toId?: unknown;
		notesMd?: unknown;
	};
	if (
		!KINDS.includes(payload.fromKind as (typeof KINDS)[number]) ||
		typeof payload.fromId !== 'string' ||
		typeof payload.relationTypeId !== 'string' ||
		typeof payload.toId !== 'string'
	) {
		error(400, 'fromKind, fromId, relationTypeId and toId are required');
	}

	const result = await createRelationship(db, locals.user!.id, {
		fromKind: payload.fromKind as (typeof KINDS)[number],
		fromId: payload.fromId,
		relationTypeId: payload.relationTypeId,
		toId: payload.toId,
		notesMd: typeof payload.notesMd === 'string' ? payload.notesMd : undefined
	});
	if (!result.ok) {
		throwActionError(result);
	}
	return json({ id: result.id }, { status: 201 });
};
