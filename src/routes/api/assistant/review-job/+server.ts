import { error, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { ownedStory } from '$lib/server/story-access';
import { rateLimitAssistant } from '$lib/server/write-guard';
import { assistantLayout } from '$lib/server/llm/config';
import { queueAssistantReview } from '$lib/server/jobs';

// Queues a whole-story or single-chapter Assistant review as a background job
// (it fans over many scenes, too long for a request). The owner is notified
// when it finishes. Both the story-settings "Review this story" button and the
// editor's "Review this chapter" menu item post here.

export const POST: RequestHandler = async ({ request, locals }) => {
	const userId = locals.user!.id;
	rateLimitAssistant(userId);

	const payload = (await request.json().catch(() => null)) as {
		storyId?: unknown;
		chapterId?: unknown;
	} | null;
	const storyRef = payload && typeof payload.storyId === 'string' ? payload.storyId : '';
	if (!storyRef) error(400, 'storyId is required.');
	const chapterId =
		payload && typeof payload.chapterId === 'string' ? payload.chapterId : undefined;

	// 404s unless the user owns the story.
	const { story } = await ownedStory(storyRef, userId);

	const layout = await assistantLayout(db, userId, story.id);
	if (!layout.surfacesEnabled) error(403, 'The Assistant is off for this story.');

	const queued = await queueAssistantReview({ userId, storyId: story.id, chapterId });
	if (!queued) error(503, 'Could not start the review. Try again in a moment.');

	return new Response(JSON.stringify({ ok: true }), {
		headers: { 'content-type': 'application/json' }
	});
};
