import { error, type RequestHandler } from '@sveltejs/kit';
import {
	readAssistantPayload,
	requireAssistantStory,
	requireAssistantUniverse
} from '$lib/server/llm/assistant-route';
import { queueAssistantReview } from '$lib/server/jobs';
import { parseCategories } from '$lib/review-shape';
import { db } from '$lib/server/db';
import { estimateStoryReview } from '$lib/server/llm/estimate';
import { AssistantDisabledError } from '$lib/server/llm/gateway';

// Queues a background Assistant review (it fans over many scenes, too long for a
// request). The owner is notified when it finishes, and the response carries the
// job id so the caller can poll it to completion. The review modal posts here
// for the chapter and story copyedit levels; the /continuity-review command
// posts here too, with mode 'continuity' and either a story focus or the whole
// universe. The scene level runs inline through /api/assistant/review.

export const POST: RequestHandler = async ({ request, locals }) => {
	const { userId, payload } = await readAssistantPayload<{
		storyId?: unknown;
		universeId?: unknown;
		chapterId?: unknown;
		categories?: unknown;
		mode?: unknown;
		estimate?: unknown;
	}>(request, locals);
	const mode = payload.mode === 'continuity' ? 'continuity' : 'full';

	// The pre-flight estimate: the same request with estimate true asks what the
	// run would send and cost, queues nothing, and contacts no endpoint. It sizes
	// the per-scene copyedit pass only, so the continuity mode and the
	// whole-universe scope are refused here rather than answered with a figure
	// for something else.
	if (payload.estimate === true) {
		if (mode === 'continuity' || typeof payload.universeId === 'string') {
			error(400, 'An estimate is not available for this review type.');
		}
		const story = await requireAssistantStory(userId, payload.storyId);
		try {
			const estimate = await estimateStoryReview(db, {
				userId,
				storyId: story.id,
				chapterId: typeof payload.chapterId === 'string' ? payload.chapterId : undefined,
				categories: parseCategories(payload.categories)
			});
			return new Response(JSON.stringify(estimate), {
				headers: { 'content-type': 'application/json' }
			});
		} catch (err) {
			// No reviewer model configured: the run itself would refuse the same way,
			// so say that instead of returning an estimate with an empty model.
			if (err instanceof AssistantDisabledError) error(400, err.message);
			throw err;
		}
	}

	let jobId: string | null;
	if (mode === 'continuity' && typeof payload.universeId === 'string') {
		const universe = await requireAssistantUniverse(userId, payload.universeId);
		jobId = await queueAssistantReview({
			userId,
			universeId: universe.id,
			categories: [],
			mode: 'continuity'
		});
	} else if (mode === 'continuity') {
		const story = await requireAssistantStory(userId, payload.storyId);
		jobId = await queueAssistantReview({
			userId,
			storyId: story.id,
			categories: [],
			mode: 'continuity'
		});
	} else {
		const chapterId = typeof payload.chapterId === 'string' ? payload.chapterId : undefined;
		const categories = parseCategories(payload.categories);
		const story = await requireAssistantStory(userId, payload.storyId);
		jobId = await queueAssistantReview({ userId, storyId: story.id, chapterId, categories });
	}
	if (!jobId) error(503, 'Could not start the review. Try again in a moment.');

	return new Response(JSON.stringify({ ok: true, jobId }), {
		headers: { 'content-type': 'application/json' }
	});
};
