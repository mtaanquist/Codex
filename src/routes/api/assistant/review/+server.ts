import { error, type RequestHandler } from '@sveltejs/kit';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import {
	reviewComments,
	reviewSuggestions,
	reviewThreads,
	scenes,
	stories
} from '$lib/server/db/schema';
import { rateLimitAssistant } from '$lib/server/write-guard';
import { assistantLayout } from '$lib/server/llm/config';
import { assembleContext, buildSystemMessage } from '$lib/server/llm/context/assemble';
import { buildReviewMessage } from '$lib/server/llm/prompts/review';
import { AssistantDisabledError, complete } from '$lib/server/llm/gateway';
import type { ChatMessage } from '$lib/server/llm/providers/types';

// A single-scene Assistant review: the model reads the scene and the assembled
// world, then stages review comments and suggested edits through the tools (the
// "writes are suggestions" invariant). It runs inline (one scene is bounded);
// the whole-story pass is a background job. Nothing reaches the prose - the
// author accepts or rejects each note on the existing review screen.

// Count the Assistant's pending notes on a scene, so the caller can report how
// many this run added.
async function countAssistantNotes(sceneId: string): Promise<number> {
	const [suggestions] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(reviewSuggestions)
		.where(
			and(
				eq(reviewSuggestions.sceneId, sceneId),
				eq(reviewSuggestions.assistant, true),
				eq(reviewSuggestions.status, 'pending')
			)
		);
	const [comments] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(reviewComments)
		.innerJoin(reviewThreads, eq(reviewComments.threadId, reviewThreads.id))
		.where(and(eq(reviewThreads.sceneId, sceneId), eq(reviewComments.assistant, true)));
	return (suggestions?.n ?? 0) + (comments?.n ?? 0);
}

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

	const context = await assembleContext(db, { userId, storyId: scene.storyId, sceneId });
	const task: ChatMessage = { role: 'user', content: buildReviewMessage(scene) };
	const messages: ChatMessage[] = context ? [buildSystemMessage(context), task] : [task];

	const before = await countAssistantNotes(sceneId);
	try {
		await complete(db, {
			userId,
			storyId: scene.storyId,
			role: 'reviewer',
			enableTools: true,
			messages,
			signal: request.signal
		});
	} catch (err) {
		if (err instanceof AssistantDisabledError) error(403, err.message);
		error(502, 'The Assistant could not complete the review. Check the endpoint in your settings.');
	}
	const after = await countAssistantNotes(sceneId);

	return new Response(JSON.stringify({ ok: true, staged: after - before }), {
		headers: { 'content-type': 'application/json' }
	});
};
