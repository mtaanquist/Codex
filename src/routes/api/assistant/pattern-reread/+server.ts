import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { db } from '#lib/server/db';
import { reviewSuggestions } from '#lib/server/db/schema';
import { ownedStory } from '#lib/server/story-access';
import {
	readAssistantPayload,
	requireAssistantGate,
	throwAssistantError
} from '#lib/server/llm/assistant-route';
import { rereadPatternEdit } from '#lib/server/llm/pattern-reread';
import { isUuid } from '#lib/slug';

// The re-read after an accept in the guided pass over a pattern note: the
// Assistant checks the changed paragraph and its neighbours and may stage one
// follow-up edit, linked to the same note. Owner only, and only while the
// Assistant is on for the story. Synchronous, like a review-thread reply.
export const POST: RequestHandler = async ({ request, locals }) => {
	const { userId, payload } = await readAssistantPayload<{ suggestionId?: unknown }>(
		request,
		locals
	);
	const suggestionId = typeof payload.suggestionId === 'string' ? payload.suggestionId : '';
	if (!isUuid(suggestionId)) error(400, 'suggestionId is required.');

	const [row] = await db
		.select({ storyId: reviewSuggestions.storyId })
		.from(reviewSuggestions)
		.where(eq(reviewSuggestions.id, suggestionId));
	if (!row) error(404, 'That suggestion does not exist.');
	// 404s unless the user owns the story the suggestion belongs to.
	const { story } = await ownedStory(row.storyId, userId);
	await requireAssistantGate(userId, story.id);

	try {
		const result = await rereadPatternEdit(db, { userId, suggestionId, signal: request.signal });
		return Response.json(result);
	} catch (err) {
		throwAssistantError(err, 'The Assistant could not re-read this spot.');
	}
};
