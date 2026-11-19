import { error, type RequestHandler } from '@sveltejs/kit';
import { db } from '#lib/server/db';
import {
	readAssistantPayload,
	requestSignal,
	requireAssistantStory,
	requireAssistantUniverse,
	throwAssistantError
} from '#lib/server/llm/assistant-route';
import { enrichEntity, type EnrichScope } from '#lib/server/llm/enrich';

// Inline entity enrichment: from where an entity appears in this story (storyId)
// or across its universe (universeId), the Assistant suggests new aliases, quick
// details, and a summary, staged for the writer to accept or reject in the
// entity editor. Synchronous (one completion); returns the staged suggestions.
// Nothing is applied to the entity here.

export const POST: RequestHandler = async ({ request, locals }) => {
	const { userId, payload } = await readAssistantPayload<{
		storyId?: unknown;
		universeId?: unknown;
		entityId?: unknown;
	}>(request, locals);
	const entityId = typeof payload.entityId === 'string' ? payload.entityId : '';
	if (!entityId) error(400, 'entityId is required.');
	// The enrichment is owner-scoped (the entity is checked against the same
	// user inside enrichEntity).
	let scope: EnrichScope;
	if (typeof payload.universeId === 'string') {
		const universe = await requireAssistantUniverse(userId, payload.universeId);
		scope = { universeId: universe.id };
	} else {
		const story = await requireAssistantStory(userId, payload.storyId);
		scope = { storyId: story.id };
	}

	let staged;
	try {
		staged = await enrichEntity(db, { userId, scope, entityId, signal: requestSignal(request) });
	} catch (err) {
		throwAssistantError(err, 'The Assistant could not suggest anything for this entry.');
	}

	return new Response(JSON.stringify({ suggestions: staged }), {
		headers: { 'content-type': 'application/json' }
	});
};
