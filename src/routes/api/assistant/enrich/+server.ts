import { error, type RequestHandler } from '@sveltejs/kit';
import { db } from '#lib/server/db';
import {
	readAssistantPayload,
	requireAssistantStory,
	requireAssistantUniverse
} from '#lib/server/llm/assistant-route';
import { enrichTarget, estimateEntityEnrich, type EnrichScope } from '#lib/server/llm/enrich';
import { queueAssistantDetails } from '#lib/server/jobs';

// Entity enrichment for one entry: from the scenes that mention it in this
// story (storyId) or across its universe (universeId), with the scene before
// and after each, the Assistant suggests new aliases, quick details, and a
// summary, staged for the writer to accept or reject in the entity editor.
// mode 'book' reads the whole story instead. The read is queued as a
// background job, since a slow model can take minutes; the writer is notified
// when it is done. With estimate: true nothing is queued and the response says
// what the reads would send, for the editor's confirm step.

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
	// The entity is checked against the same user, and against the universe the
	// scope reads from, in enrichTarget and the estimate.
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

	const target = await enrichTarget(db, { userId, scope, entityId });
	if (!target) error(404, 'Not found.');

	const jobId = await queueAssistantDetails({
		userId,
		universeId: target.universeId,
		read: {
			entityId,
			name: target.name,
			mode,
			...('storyId' in scope ? { storyId: scope.storyId } : {})
		}
	});
	if (jobId === 'coalesced') {
		error(
			409,
			'The Assistant is already reading for this entry. It carries on; this started nothing new.'
		);
	}
	if (!jobId) error(503, 'Could not start the read. Try again in a moment.');

	return Response.json({ ok: true, jobId });
};
