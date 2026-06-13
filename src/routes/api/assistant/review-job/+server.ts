import { error, type RequestHandler } from '@sveltejs/kit';
import { readAssistantPayload, requireAssistantStory } from '$lib/server/llm/assistant-route';
import { queueAssistantReview } from '$lib/server/jobs';
import { parseCategories } from '$lib/review-shape';

// Queues a whole-story or single-chapter Assistant review as a background job
// (it fans over many scenes, too long for a request). The owner is notified
// when it finishes, and the response carries the job id so the caller can poll
// it to completion. The review modal posts here for the chapter and story
// levels; the scene level runs inline through /api/assistant/review.

export const POST: RequestHandler = async ({ request, locals }) => {
	const { userId, payload } = await readAssistantPayload<{
		storyId?: unknown;
		chapterId?: unknown;
		categories?: unknown;
	}>(request, locals);
	const chapterId = typeof payload.chapterId === 'string' ? payload.chapterId : undefined;
	const categories = parseCategories(payload.categories);
	const story = await requireAssistantStory(userId, payload.storyId);

	const jobId = await queueAssistantReview({ userId, storyId: story.id, chapterId, categories });
	if (!jobId) error(503, 'Could not start the review. Try again in a moment.');

	return new Response(JSON.stringify({ ok: true, jobId }), {
		headers: { 'content-type': 'application/json' }
	});
};
