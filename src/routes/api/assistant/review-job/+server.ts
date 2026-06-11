import { error, type RequestHandler } from '@sveltejs/kit';
import { readAssistantPayload, requireAssistantStory } from '$lib/server/llm/assistant-route';
import { queueAssistantReview } from '$lib/server/jobs';

// Queues a whole-story or single-chapter Assistant review as a background job
// (it fans over many scenes, too long for a request). The owner is notified
// when it finishes. Both the story-settings "Review this story" button and the
// editor's "Review this chapter" menu item post here.

export const POST: RequestHandler = async ({ request, locals }) => {
	const { userId, payload } = await readAssistantPayload<{
		storyId?: unknown;
		chapterId?: unknown;
	}>(request, locals);
	const chapterId = typeof payload.chapterId === 'string' ? payload.chapterId : undefined;
	const story = await requireAssistantStory(userId, payload.storyId);

	const queued = await queueAssistantReview({ userId, storyId: story.id, chapterId });
	if (!queued) error(503, 'Could not start the review. Try again in a moment.');

	return new Response(JSON.stringify({ ok: true }), {
		headers: { 'content-type': 'application/json' }
	});
};
