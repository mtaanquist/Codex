import { error, type RequestHandler } from '@sveltejs/kit';
import { db } from '#lib/server/db';
import {
	readAssistantPayload,
	requestSignal,
	requireAssistantStory,
	requireAssistantUniverse,
	throwAssistantError
} from '#lib/server/llm/assistant-route';
import {
	enrichEntityFromText,
	estimateEntityEnrich,
	type EnrichScope
} from '#lib/server/llm/enrich';

// Inline entity enrichment: from the scenes that mention an entity in this
// story (storyId) or across its universe (universeId), with the scene before
// and after each, the Assistant suggests new aliases, quick details, and a
// summary, staged for the writer to accept or reject in the entity editor.
// mode 'book' reads the whole story instead. Synchronous; a long text is read
// in several requests. Returns the staged suggestions. Nothing is applied to
// the entity here. With estimate: true it sends nothing and returns what the
// reads would send, for the editor's confirm step.

export const POST: RequestHandler = async ({ request, locals }) => {
	const { userId, payload } = await readAssistantPayload<{
		storyId?: unknown;
		universeId?: unknown;
		entityId?: unknown;
		mode?: unknown;
		estimate?: unknown;
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

	if (payload.estimate === true) {
		const estimate = await estimateEntityEnrich(db, { userId, scope, entityId });
		if (!estimate) error(404, 'Not found.');
		return new Response(JSON.stringify(estimate), {
			headers: { 'content-type': 'application/json' }
		});
	}

	if (payload.mode !== undefined && payload.mode !== 'scenes' && payload.mode !== 'book') {
		error(400, 'mode must be scenes or book.');
	}
	const mode = payload.mode ?? 'scenes';
	if (mode === 'book' && !('storyId' in scope)) error(400, 'The whole book needs a story.');

	let result;
	try {
		result = await enrichEntityFromText(db, {
			userId,
			scope,
			entityId,
			mode,
			signal: requestSignal(request)
		});
	} catch (err) {
		throwAssistantError(err, 'The Assistant could not suggest anything for this entry.');
	}

	return new Response(JSON.stringify(result), {
		headers: { 'content-type': 'application/json' }
	});
};
