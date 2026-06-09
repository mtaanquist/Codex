import { error, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { ownedStory } from '$lib/server/story-access';
import { rateLimitAssistant } from '$lib/server/write-guard';
import { assistantLayout } from '$lib/server/llm/config';
import { enrichEntity } from '$lib/server/llm/enrich';
import { AssistantDisabledError } from '$lib/server/llm/gateway';

// Inline entity enrichment: from where an entity appears in this story, the
// Assistant suggests new aliases, quick details, and a summary, staged for the
// writer to accept or reject in the entity editor. Synchronous (one completion);
// returns the staged suggestions. Nothing is applied to the entity here.

export const POST: RequestHandler = async ({ request, locals }) => {
	const userId = locals.user!.id;
	rateLimitAssistant(userId);

	const payload = (await request.json().catch(() => null)) as {
		storyId?: unknown;
		entityId?: unknown;
	} | null;
	const storyId = payload && typeof payload.storyId === 'string' ? payload.storyId : '';
	const entityId = payload && typeof payload.entityId === 'string' ? payload.entityId : '';
	if (!storyId) error(400, 'storyId is required.');
	if (!entityId) error(400, 'entityId is required.');

	// 404s unless the user owns the story; the enrichment is owner-scoped (the
	// entity is checked against the same user inside enrichEntity).
	const { story } = await ownedStory(storyId, userId);

	const layout = await assistantLayout(db, userId, story.id);
	if (!layout.surfacesEnabled) error(403, 'The Assistant is off for this story.');

	let staged;
	try {
		staged = await enrichEntity(db, {
			userId,
			storyId: story.id,
			entityId,
			signal: request.signal
		});
	} catch (err) {
		if (err instanceof AssistantDisabledError) error(403, err.message);
		error(502, 'The Assistant could not suggest anything for this entry.');
	}

	return new Response(JSON.stringify({ suggestions: staged }), {
		headers: { 'content-type': 'application/json' }
	});
};
