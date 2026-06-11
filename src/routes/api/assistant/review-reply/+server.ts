import { error, json } from '@sveltejs/kit';
import { and, eq, sql } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { reviewComments, reviewThreads, scenes } from '$lib/server/db/schema';
import { ownedStory } from '$lib/server/story-access';
import {
	readAssistantPayload,
	requireAssistantGate,
	throwAssistantError
} from '$lib/server/llm/assistant-route';
import { assembleContext, buildSystemMessage } from '$lib/server/llm/context/assemble';
import { buildReviewReplyMessage, excerptAround } from '$lib/server/llm/prompts/review-reply';
import { complete } from '$lib/server/llm/gateway';
import { addComment, listSuggestions, listThreads } from '$lib/server/review';
import { reanchorRange } from '$lib/review-anchor';
import { isUuid } from '$lib/slug';
import type { ChatMessage } from '$lib/server/llm/providers/types';

// The Assistant answering in a review thread it opened: triggered after the
// author replies there. It runs with two scoped tools - reply_in_thread, and
// update_suggestion when the thread discusses one of its suggestions - whose
// targets are fixed here, never taken from the model. Only the story owner
// can trigger it, and only on assistant-rooted threads, so a guest reviewer
// can never spend the owner's endpoint.

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

	// The full thread view carries the re-anchored range and display names.
	const threads = await listThreads(db, story.id, reanchorRange, { userId });
	const thread = threads.find((t) => t.id === threadId);
	if (!thread) error(404, 'That thread does not exist.');
	if (!thread.comments[0]?.isAssistant) {
		error(400, 'The Assistant only replies in threads it opened.');
	}

	const suggestion = thread.suggestionId
		? ((await listSuggestions(db, story.id)).find((s) => s.id === thread.suggestionId) ?? null)
		: null;

	const [scene] = await db
		.select({ title: scenes.title, bodyMd: scenes.bodyMd })
		.from(scenes)
		.where(eq(scenes.id, thread.sceneId));
	if (!scene) error(404, 'That scene does not exist.');

	const task: ChatMessage = {
		role: 'user',
		content: buildReviewReplyMessage({
			sceneTitle: scene.title,
			excerpt: excerptAround(scene.bodyMd, thread.anchor),
			transcript: thread.comments.map((comment) => ({
				author: comment.isAssistant ? layout.name : comment.authorName,
				body: comment.body
			})),
			suggestion:
				suggestion && suggestion.status === 'pending'
					? { original: suggestion.original, replacement: suggestion.replacement }
					: null
		})
	};
	const context = await assembleContext(db, {
		userId,
		storyId: story.id,
		sceneId: thread.sceneId
	});
	const messages: ChatMessage[] = context
		? [buildSystemMessage(context, { tools: true }), task]
		: [task];

	const repliesBefore = await assistantCommentCount(threadId);
	let content: string;
	try {
		content = await complete(db, {
			userId,
			storyId: story.id,
			role: 'reviewer',
			enableTools: true,
			toolNames: [
				'list_scenes',
				'get_scene',
				'get_entity',
				'find_appearances',
				'search_text',
				'reply_in_thread',
				...(suggestion && suggestion.status === 'pending' ? ['update_suggestion'] : [])
			],
			toolScope: { threadId, suggestionId: thread.suggestionId ?? undefined },
			messages,
			signal: request.signal
		});
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

	return json({ replied });
};
