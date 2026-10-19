import { error, type RequestHandler } from '@sveltejs/kit';
import { readAssistantPayload, requireAssistantUniverse } from '$lib/server/llm/assistant-route';
import { queueAssistantEnrich } from '$lib/server/jobs';

// Queues the whole-universe enrichment pass as a background job (one completion
// per entry, too long for a request). The Assistant suggests aliases, quick
// details, and summaries for every entry the prose mentions, staged for the
// writer to accept or reject on the universe Plan. The owner is notified when
// it finishes.

export const POST: RequestHandler = async ({ request, locals }) => {
	const { userId, payload } = await readAssistantPayload<{ universeId?: unknown }>(request, locals);
	const universe = await requireAssistantUniverse(userId, payload.universeId);

	const jobId = await queueAssistantEnrich({ userId, universeId: universe.id });
	if (!jobId) error(503, 'Could not start the suggestion pass. Try again in a moment.');

	return new Response(JSON.stringify({ ok: true, jobId }), {
		headers: { 'content-type': 'application/json' }
	});
};
