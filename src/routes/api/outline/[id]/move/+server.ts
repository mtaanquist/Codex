import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { moveOutlineNode } from '$lib/server/outline';

export const POST: RequestHandler = async ({ params, request, locals }) => {
	const payload = (await request.json()) as { direction?: unknown };
	if (payload.direction !== 'indent' && payload.direction !== 'outdent') {
		error(400, 'direction must be indent or outdent');
	}
	const result = await moveOutlineNode(db, params.id, locals.user!.id, payload.direction);
	if (!result.ok) {
		error(result.reason.includes('not found') ? 404 : 400, result.reason);
	}
	return json({ ok: true });
};
