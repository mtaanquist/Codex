import { error, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { decideEntitySuggestion } from '$lib/server/entity-suggestions';

// Accept or reject one staged entity suggestion. Owner-scoped in the data layer.
// Accepting applies the single field (alias / detail / summary) to the entity and
// records a 'suggestion' revision; rejecting just marks it. No Assistant gate:
// the writer is acting on an already-staged suggestion, not generating.

export const POST: RequestHandler = async ({ request, params, locals }) => {
	const userId = locals.user!.id;
	const id = params.id!;

	const payload = (await request.json().catch(() => null)) as { decision?: unknown } | null;
	const decision = payload && payload.decision === 'reject' ? 'reject' : 'accept';

	const result = await decideEntitySuggestion(db, userId, id, decision);
	if (!result.ok) error(404, result.reason ?? 'Suggestion not found.');

	return new Response(JSON.stringify({ ok: true }), {
		headers: { 'content-type': 'application/json' }
	});
};
