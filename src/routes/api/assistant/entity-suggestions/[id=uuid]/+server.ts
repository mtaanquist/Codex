import { type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { throwActionError } from '$lib/server/action-result';
import { decideEntitySuggestion } from '$lib/server/entity-suggestions';
import { readJson } from '$lib/server/validation';

// Accept or reject one staged entity suggestion. Owner-scoped in the data layer.
// Accepting applies the single field (alias / detail / summary) to the entity and
// records a 'suggestion' revision; rejecting just marks it. No Assistant gate:
// the writer is acting on an already-staged suggestion, not generating.

export const POST: RequestHandler = async ({ request, params, locals }) => {
	const userId = locals.user!.id;
	const id = params.id!;

	const payload = await readJson<{ decision?: unknown }>(request);
	const decision = payload.decision === 'reject' ? 'reject' : 'accept';

	const result = await decideEntitySuggestion(db, userId, id, decision);
	if (!result.ok) throwActionError(result);
	return Response.json({ ok: true });
};
