import { error, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { ownedStory } from '$lib/server/story-access';
import { rateLimitAssistant } from '$lib/server/write-guard';
import { assistantLayout } from '$lib/server/llm/config';
import { queueAssistantSummaries } from '$lib/server/jobs';

// Queues whole-story summary maintenance as a background job (it reads every
// scene, too long for a request). The Assistant drafts missing scene and chapter
// summaries and refreshes the ones it wrote when the prose has changed, leaving
// any summary the writer wrote by hand alone. The owner is notified when it
// finishes.

export const POST: RequestHandler = async ({ request, locals }) => {
	const userId = locals.user!.id;
	rateLimitAssistant(userId);

	const payload = (await request.json().catch(() => null)) as { storyId?: unknown } | null;
	const storyRef = payload && typeof payload.storyId === 'string' ? payload.storyId : '';
	if (!storyRef) error(400, 'storyId is required.');

	// 404s unless the user owns the story.
	const { story } = await ownedStory(storyRef, userId);

	const layout = await assistantLayout(db, userId, story.id);
	if (!layout.surfacesEnabled) error(403, 'The Assistant is off for this story.');

	const queued = await queueAssistantSummaries({ userId, storyId: story.id });
	if (!queued) error(503, 'Could not start the summary pass. Try again in a moment.');

	return new Response(JSON.stringify({ ok: true }), {
		headers: { 'content-type': 'application/json' }
	});
};
