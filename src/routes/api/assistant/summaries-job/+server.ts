import { error, type RequestHandler } from '@sveltejs/kit';
import { readAssistantPayload, requireAssistantStory } from '$lib/server/llm/assistant-route';
import { queueAssistantSummaries } from '$lib/server/jobs';

// Queues whole-story summary maintenance as a background job (it reads every
// scene, too long for a request). The Assistant drafts missing scene and chapter
// summaries and refreshes the ones it wrote when the prose has changed, leaving
// any summary the writer wrote by hand alone. The owner is notified when it
// finishes.

export const POST: RequestHandler = async ({ request, locals }) => {
	const { userId, payload } = await readAssistantPayload<{ storyId?: unknown }>(request, locals);
	const story = await requireAssistantStory(userId, payload.storyId);

	const jobId = await queueAssistantSummaries({ userId, storyId: story.id });
	if (!jobId) error(503, 'Could not start the summary pass. Try again in a moment.');

	return new Response(JSON.stringify({ ok: true, jobId }), {
		headers: { 'content-type': 'application/json' }
	});
};
