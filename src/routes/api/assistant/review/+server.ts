import { error, type RequestHandler } from '@sveltejs/kit';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { scenes, stories } from '$lib/server/db/schema';
import {
	readAssistantPayload,
	requireAssistantGate,
	throwAssistantError
} from '$lib/server/llm/assistant-route';
import { countAssistantNotes, reviewOneScene } from '$lib/server/llm/scene-review';
import { REVIEW_FOCUSES, type ReviewFocus } from '$lib/server/llm/prompts/review';

// A single-scene Assistant review, run inline (one scene is bounded). The model
// reads the scene and the assembled world, then stages review comments and
// suggested edits through the tools - nothing reaches the prose, the author
// accepts or rejects each note on the existing review screen. The whole-story
// and chapter passes are the assistant-review background job.

export const POST: RequestHandler = async ({ request, locals }) => {
	const { userId, payload } = await readAssistantPayload<{ sceneId?: unknown; focus?: unknown }>(
		request,
		locals
	);
	const sceneId = typeof payload.sceneId === 'string' ? payload.sceneId : '';
	if (!sceneId) error(400, 'sceneId is required.');
	const focus: ReviewFocus =
		typeof payload.focus === 'string' &&
		(REVIEW_FOCUSES as readonly string[]).includes(payload.focus)
			? (payload.focus as ReviewFocus)
			: 'notes';

	// Owner-scoped: resolve the scene and its story, 404ing unless the user owns it.
	const [scene] = await db
		.select({ id: scenes.id, title: scenes.title, storyId: scenes.storyId })
		.from(scenes)
		.innerJoin(stories, eq(scenes.storyId, stories.id))
		.where(and(eq(scenes.id, sceneId), eq(stories.ownerId, userId), isNull(scenes.deletedAt)));
	if (!scene) error(404, 'Scene not found');

	await requireAssistantGate(userId, scene.storyId);

	const before = await countAssistantNotes(db, sceneId);
	try {
		await reviewOneScene(db, {
			userId,
			storyId: scene.storyId,
			scene,
			focus,
			signal: request.signal
		});
	} catch (err) {
		throwAssistantError(
			err,
			'The Assistant could not complete the review. Check the endpoint in your settings.'
		);
	}
	const after = await countAssistantNotes(db, sceneId);

	// The count is cosmetic and the two snapshots are not transactional, so a
	// concurrent decision could make the difference negative; clamp it.
	return new Response(JSON.stringify({ ok: true, staged: Math.max(0, after - before) }), {
		headers: { 'content-type': 'application/json' }
	});
};
