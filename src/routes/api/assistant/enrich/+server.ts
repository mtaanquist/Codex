import { error, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import {
	readAssistantPayload,
	requireAssistantStory,
	throwAssistantError
} from '$lib/server/llm/assistant-route';
import { enrichEntity } from '$lib/server/llm/enrich';

// Inline entity enrichment: from where an entity appears in this story, the
// Assistant suggests new aliases, quick details, and a summary, staged for the
// writer to accept or reject in the entity editor. Synchronous (one completion);
// returns the staged suggestions. Nothing is applied to the entity here.

export const POST: RequestHandler = async ({ request, locals }) => {
	const { userId, payload } = await readAssistantPayload<{
		storyId?: unknown;
		entityId?: unknown;
	}>(request, locals);
	const entityId = typeof payload.entityId === 'string' ? payload.entityId : '';
	if (!entityId) error(400, 'entityId is required.');
	// The enrichment is owner-scoped (the entity is checked against the same
	// user inside enrichEntity).
	const story = await requireAssistantStory(userId, payload.storyId);

	let staged;
	try {
		staged = await enrichEntity(db, {
			userId,
			storyId: story.id,
			entityId,
			signal: request.signal
		});
	} catch (err) {
		throwAssistantError(err, 'The Assistant could not suggest anything for this entry.');
	}

	return new Response(JSON.stringify({ suggestions: staged }), {
		headers: { 'content-type': 'application/json' }
	});
};
