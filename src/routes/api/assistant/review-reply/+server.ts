import { error } from '@sveltejs/kit';
import { and, eq, sql } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { db } from '#lib/server/db';
import { reviewComments, reviewThreads } from '#lib/server/db/schema';
import { ownedStory } from '#lib/server/story-access';
import {
	readAssistantPayload,
	requireAssistantGate,
	throwAssistantError
} from '#lib/server/llm/assistant-route';
import { complete } from '#lib/server/llm/gateway';
import { prepareReviewReply } from '#lib/server/llm/review-reply';
import { addComment } from '#lib/server/review';
import { isUuid } from '#lib/slug';

// The Assistant answering in a review thread it opened: triggered after the
// author replies there. It runs with two scoped tools - reply_in_thread, and
// update_suggestion when the thread discusses one of its suggestions - whose
// targets are fixed server-side, never taken from the model, plus scene reads
// held to this story (guests read the reply; see prepareReviewReply). Only the
// story owner can trigger it, and only on assistant-rooted threads, so a guest
// reviewer can never spend the owner's endpoint.

async function assistantCommentCount(threadId: string): Promise<number> {
	const [row] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(reviewComments)
		.where(and(eq(reviewComments.threadId, threadId), eq(reviewComments.assistant, true)));
	return row?.n ?? 0;
}

export const POST: RequestHandler = async ({ request, locals }) => {
	const { userId, payload } = await readAssistantPayload<{ threadId?: unknown }>(request, locals);
	const threadId = typeof payload.threadId === 'string' ? payload.threadId : '';
	if (!isUuid(threadId)) error(400, 'threadId is required.');

	const [threadRow] = await db
		.select({ storyId: reviewThreads.storyId })
		.from(reviewThreads)
		.where(eq(reviewThreads.id, threadId));
	if (!threadRow) error(404, 'That thread does not exist.');

	// 404s unless the user owns the story the thread belongs to.
	const { story } = await ownedStory(threadRow.storyId, userId);

	const layout = await requireAssistantGate(userId, story.id);

	const turn = await prepareReviewReply(db, {
		userId,
		storyId: story.id,
		threadId,
		assistantName: layout.name
	});

	const repliesBefore = await assistantCommentCount(threadId);
	let content: string;
	try {
		content = await complete(db, { ...turn, signal: request.signal });
	} catch (err) {
		throwAssistantError(err, 'The Assistant could not reply.');
	}

	// The author asked a question and must hear back in the thread: if the turn
	// ended in prose without a reply_in_thread call, stage that prose as the
	// reply.
	let replied = (await assistantCommentCount(threadId)) > repliesBefore;
	if (!replied && content.trim()) {
		const staged = await addComment(db, {
			storyId: story.id,
			threadId,
			author: { assistant: true },
			body: content.trim()
		});
		replied = staged.ok;
	}

	return Response.json({ replied });
};
