import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { throwActionError } from '$lib/server/action-result';
import { queueSceneMentions, queueUniverseMentions } from '$lib/server/jobs';
import { restoreRevision, type RevisionEntityType } from '$lib/server/revisions';

const REVISABLE = ['scene', 'character', 'place', 'lore_entry', 'outline_node'] as const;

// Replaces the entity's text with the revision's; a new 'restore' revision
// lands on top of the timeline, so nothing is overwritten.
export const POST: RequestHandler = async ({ params, request, locals }) => {
	const payload = (await request.json()) as { entityType?: unknown; entityId?: unknown };
	if (
		!REVISABLE.includes(payload.entityType as (typeof REVISABLE)[number]) ||
		typeof payload.entityId !== 'string'
	) {
		error(400, 'entityType and entityId are required');
	}
	const entityType = payload.entityType as RevisionEntityType;
	const result = await restoreRevision(
		db,
		locals.user!.id,
		params.id,
		entityType,
		payload.entityId
	);
	if (!result.ok) throwActionError(result);
	if (entityType === 'scene') {
		await queueSceneMentions(payload.entityId);
	}
	// A restored name or alias set can add or remove mentions anywhere in
	// the universe.
	if (result.mentionsAffected && result.universeId) {
		await queueUniverseMentions(result.universeId);
	}
	return json({ ok: true });
};
