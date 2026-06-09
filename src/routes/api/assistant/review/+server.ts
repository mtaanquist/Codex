import { error, type RequestHandler } from '@sveltejs/kit';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { scenes, stories } from '$lib/server/db/schema';
import { rateLimitAssistant } from '$lib/server/write-guard';
import { assistantLayout } from '$lib/server/llm/config';
import { AssistantDisabledError } from '$lib/server/llm/gateway';
import { countAssistantNotes, reviewOneScene } from '$lib/server/llm/scene-review';

// A single-scene Assistant review, run inline (one scene is bounded). The model
// reads the scene and the assembled world, then stages review comments and
// suggested edits through the tools - nothing reaches the prose, the author
// accepts or rejects each note on the existing review screen. The whole-story
// and chapter passes are the assistant-review background job.

export const POST: RequestHandler = async ({ request, locals }) => {
	const userId = locals.user!.id;
	rateLimitAssistant(userId);

	const payload = (await request.json().catch(() => null)) as { sceneId?: unknown } | null;
	const sceneId = payload && typeof payload.sceneId === 'string' ? payload.sceneId : '';
	if (!sceneId) error(400, 'sceneId is required.');

	// Owner-scoped: resolve the scene and its story, 404ing unless the user owns it.
	const [scene] = await db
		.select({ id: scenes.id, title: scenes.title, storyId: scenes.storyId })
		.from(scenes)
		.innerJoin(stories, eq(scenes.storyId, stories.id))
		.where(and(eq(scenes.id, sceneId), eq(stories.ownerId, userId), isNull(scenes.deletedAt)));
	if (!scene) error(404, 'Scene not found');

	const layout = await assistantLayout(db, userId, scene.storyId);
	if (!layout.surfacesEnabled) error(403, 'The Assistant is off for this story.');

	const before = await countAssistantNotes(db, sceneId);
	try {
		await reviewOneScene(db, {
			userId,
			storyId: scene.storyId,
			scene,
			signal: request.signal
		});
	} catch (err) {
		if (err instanceof AssistantDisabledError) error(403, err.message);
		error(502, 'The Assistant could not complete the review. Check the endpoint in your settings.');
	}
	const after = await countAssistantNotes(db, sceneId);

	return new Response(JSON.stringify({ ok: true, staged: after - before }), {
		headers: { 'content-type': 'application/json' }
	});
};
