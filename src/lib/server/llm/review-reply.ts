import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { Database } from '../auth';
import { scenes } from '../db/schema';
import { listSuggestions, listThreads } from '../review';
import { createAnchorMapper } from '$lib/review-anchor';
import { assembleReviewReplyContext, buildSystemMessage } from './context/assemble';
import {
	buildReviewReplyMessage,
	excerptAround,
	reviewReplyToolNames
} from './prompts/review-reply';
import type { GatewayRequest } from './gateway';
import type { ChatMessage } from './providers/types';

// The gateway request for the Assistant's answer in a review thread it opened,
// for a story the caller has already checked the user owns. Throws a 404 or
// 400 for a thread that is missing or not the Assistant's. Guests read the
// reply and wrote part of the transcript, so the context and the reads stop
// at what the guest review page shows (see assembleReviewReplyContext and
// reviewReplyToolNames).
export async function prepareReviewReply(
	db: Database,
	input: { userId: string; storyId: string; threadId: string; assistantName: string }
): Promise<Omit<GatewayRequest, 'signal'>> {
	const { userId, storyId, threadId } = input;
	// The full thread view carries the re-anchored range and display names. One
	// mapper covers the threads and the suggestion lookup below, so a scene
	// revision is diffed once rather than once per anchor.
	const anchors = createAnchorMapper();
	const threads = await listThreads(db, storyId, anchors.range, { userId });
	const thread = threads.find((t) => t.id === threadId);
	if (!thread) error(404, 'That thread does not exist.');
	if (!thread.comments[0]?.isAssistant) {
		error(400, 'The Assistant only replies in threads it opened.');
	}

	const suggestion = thread.suggestionId
		? ((await listSuggestions(db, storyId, undefined, anchors)).find(
				(s) => s.id === thread.suggestionId
			) ?? null)
		: null;
	const pending = suggestion?.status === 'pending' ? suggestion : null;

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
				author: comment.isAssistant ? input.assistantName : comment.authorName,
				body: comment.body
			})),
			suggestion: pending ? { original: pending.original, replacement: pending.replacement } : null
		})
	};
	// The passage is already in the task message as an excerpt; the reply needs
	// the story frame (with the style notes the note was judged against) and the
	// entities the passage may name. Anything else it reads with the tools.
	const context = await assembleReviewReplyContext(db, { userId, storyId });
	const messages: ChatMessage[] = context
		? // No tool hint: the slim reply context ships no outline for the hint's
			// "scene ids shown in the outline" to point at, and the task message
			// already names the scoped tools this turn may use.
			[buildSystemMessage(context), task]
		: [task];

	return {
		userId,
		storyId,
		role: 'reviewer',
		enableTools: true,
		toolNames: reviewReplyToolNames(pending !== null),
		toolScope: { threadId, suggestionId: thread.suggestionId ?? undefined, storyOnly: true },
		messages
	};
}
