import { error, type RequestHandler } from '@sveltejs/kit';
import {
	readAssistantPayload,
	requireAssistantStory,
	requireAssistantUniverse
} from '#lib/server/llm/assistant-route';
import { queueAssistantEnrich } from '#lib/server/jobs';

// Queues the background enrichment pass over a universe's entries (too long for
// a request). From the universe surface it names the universe; from a story it
// runs over that story's universe. The Assistant stages alias, detail, and
// summary suggestions for every entry with new prose to read, and the owner is
// notified when it finishes.

export const POST: RequestHandler = async ({ request, locals }) => {
	const { userId, payload } = await readAssistantPayload<{
		storyId?: unknown;
		universeId?: unknown;
	}>(request, locals);

	const universeId =
		typeof payload.universeId === 'string'
			? (await requireAssistantUniverse(userId, payload.universeId)).id
			: (await requireAssistantStory(userId, payload.storyId)).universeId;

	const jobId = await queueAssistantEnrich({ userId, universeId });
	if (jobId === 'coalesced') {
		error(
			409,
			'The Assistant is already reading the entries in this universe. It carries on; this request started nothing new.'
		);
	}
	if (!jobId) error(503, 'Could not start the pass. Try again in a moment.');

	return Response.json({ ok: true, jobId });
};
