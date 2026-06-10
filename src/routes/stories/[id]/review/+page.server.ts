import { fail } from '@sveltejs/kit';
import { isUuid } from '$lib/slug';
import { ownedStory } from '$lib/server/story-access';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import {
	acceptAllInScene,
	addComment,
	createSuggestion,
	createThread,
	decideSuggestion,
	deleteComment,
	deleteSuggestion,
	ensureSuggestionThread,
	listSuggestions,
	listThreads,
	setThreadResolved
} from '$lib/server/review';
import { gatherStory } from '$lib/server/export';
import { storyPreferences } from '$lib/server/preferences';
import { reviewMentionData } from '$lib/server/mention-entities';
import { reanchorRange } from '$lib/review-anchor';
import { queueSceneMentions } from '$lib/server/jobs';
import { assistantLayout } from '$lib/server/llm/config';
import { notifySuggestionDiscussion, notifyThreadReviewers } from '$lib/server/notify';
import { teaser } from '$lib/notifications';

// The author's side of a review: every thread guests have left on the
// story, against the current text, with reply and resolve.

export const load: PageServerLoad = async ({ params, locals }) => {
	const { story, universe } = await ownedStory(params.id, locals.user!.id);
	const content = await gatherStory(db, story);
	const scenes = content.scenes.map((scene) => ({
		id: scene.id!,
		chapterId: scene.chapterId,
		title: scene.title,
		status: scene.status ?? 'todo',
		bodyMd: scene.bodyMd
	}));
	// The author sees the full cast in their own review, like the editor.
	const mentions = await reviewMentionData(db, {
		universeId: story.universeId,
		storyId: story.id,
		sceneIds: scenes.map((scene) => scene.id),
		restrictToMentioned: false
	});
	return {
		story: { id: story.id, slug: story.slug, title: story.title, universeId: story.universeId },
		universe: { slug: universe.slug, name: universe.name },
		chapters: content.chapters,
		scenes,
		threads: await listThreads(db, story.id, reanchorRange, { userId: locals.user!.id }),
		suggestions: await listSuggestions(db, story.id, { userId: locals.user!.id }),
		mentionEntities: mentions.entities,
		mentionMembers: mentions.storyMembers,
		mentionPins: mentions.pins,
		// The editor view toggles, shared with the Write editor.
		preferences: await storyPreferences(db, locals.user!.id, story.id),
		// Whether the Assistant answers in its threads here, and under what name.
		assistant: await assistantLayout(db, locals.user!.id, story.id)
	};
};

export const actions: Actions = {
	// The author leaving their own note, like a guest reviewer would. A null
	// anchor is a whole-scene comment; a range is a selection.
	comment: async ({ params, request, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		const start = Number(data.get('start'));
		const end = Number(data.get('end'));
		const anchor =
			Number.isInteger(start) && Number.isInteger(end) && end > start && start >= 0
				? { start, end }
				: null;
		const sceneId = String(data.get('sceneId') ?? '');
		if (!isUuid(sceneId)) return fail(400, { message: 'That scene does not exist.' });
		const result = await createThread(db, {
			storyId: story.id,
			sceneId,
			anchor,
			author: { userId: locals.user!.id },
			body: String(data.get('body') ?? '')
		});
		if (!result.ok) return fail(400, { message: result.reason });
		return { done: true };
	},
	// The author proposing an edit on their own story; guests reviewing see it
	// like any other suggestion. The author owns the story, so no canSuggest gate.
	suggest: async ({ params, request, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		const sceneId = String(data.get('sceneId') ?? '');
		if (!isUuid(sceneId)) return fail(400, { message: 'That scene does not exist.' });
		const result = await createSuggestion(db, {
			storyId: story.id,
			sceneId,
			author: { userId: locals.user!.id },
			range: { start: Number(data.get('start')), end: Number(data.get('end')) },
			replacement: String(data.get('replacement') ?? '')
		});
		if (!result.ok) return fail(400, { message: result.reason });
		return { done: true };
	},
	reply: async ({ params, request, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		const threadId = String(data.get('threadId') ?? '');
		if (!isUuid(threadId)) return fail(400, { message: 'That thread does not exist.' });
		const result = await addComment(db, {
			storyId: story.id,
			threadId,
			author: { userId: locals.user!.id },
			body: String(data.get('body') ?? '')
		});
		if (!result.ok) return fail(400, { message: result.reason });
		// Reviewers in the thread hear back; their review link is the way in,
		// so the notification informs without navigating.
		await notifyThreadReviewers(db, threadId, {
			title: `${locals.user!.displayName} replied to your comment on "${story.title}"`,
			detail: teaser(String(data.get('body') ?? ''))
		});
		return { done: true };
	},
	// The author replying on a suggestion's card: its discussion thread is
	// created on the first reply. Returns the thread id so the client can have
	// the Assistant answer in it when the suggestion is the Assistant's.
	replySuggestion: async ({ params, request, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		const suggestionId = String(data.get('suggestionId') ?? '');
		if (!isUuid(suggestionId)) return fail(400, { message: 'That suggestion does not exist.' });
		const thread = await ensureSuggestionThread(db, { storyId: story.id, suggestionId });
		if (!thread.ok) return fail(400, { message: thread.reason });
		const body = String(data.get('body') ?? '');
		const result = await addComment(db, {
			storyId: story.id,
			threadId: thread.threadId,
			author: { userId: locals.user!.id },
			body
		});
		if (!result.ok) return fail(400, { message: result.reason });
		// The suggestion's reviewer hears about the discussion even before they
		// have commented in it; so does everyone already in the thread.
		await notifySuggestionDiscussion(
			db,
			{ suggestionId, threadId: thread.threadId },
			{
				title: `${locals.user!.displayName} replied on your suggested edit on "${story.title}"`,
				detail: teaser(body)
			}
		);
		return { done: true, threadId: thread.threadId };
	},
	resolve: async ({ params, request, locals }) => {
		await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		const threadId = String(data.get('threadId') ?? '');
		if (!isUuid(threadId) || !(await setThreadResolved(db, locals.user!.id, threadId, true))) {
			return fail(400, { message: 'That thread could not be resolved.' });
		}
		return { done: true };
	},
	reopen: async ({ params, request, locals }) => {
		await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		const threadId = String(data.get('threadId') ?? '');
		if (!isUuid(threadId) || !(await setThreadResolved(db, locals.user!.id, threadId, false))) {
			return fail(400, { message: 'That thread could not be reopened.' });
		}
		return { done: true };
	},
	acceptSuggestion: async ({ params, request, locals }) => {
		await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		const suggestionId = String(data.get('suggestionId') ?? '');
		if (!isUuid(suggestionId)) return fail(400, { message: 'That suggestion does not exist.' });
		const result = await decideSuggestion(db, locals.user!.id, suggestionId, true);
		if (!result.ok) return fail(400, { message: result.reason });
		// The body changed; keep the mention index in step.
		if (result.sceneId) await queueSceneMentions(result.sceneId);
		return { done: true };
	},
	rejectSuggestion: async ({ params, request, locals }) => {
		await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		const suggestionId = String(data.get('suggestionId') ?? '');
		if (!isUuid(suggestionId)) return fail(400, { message: 'That suggestion does not exist.' });
		const result = await decideSuggestion(db, locals.user!.id, suggestionId, false);
		if (!result.ok) return fail(400, { message: result.reason });
		return { done: true };
	},
	// Accepts every pending suggestion in one scene at once.
	acceptAll: async ({ params, request, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		const sceneId = String(data.get('sceneId') ?? '');
		if (!isUuid(sceneId)) return fail(400, { message: 'That scene does not exist.' });
		const result = await acceptAllInScene(db, locals.user!.id, story.id, sceneId);
		// The body changed; keep the mention index in step.
		if (result.accepted > 0) await queueSceneMentions(sceneId);
		return { done: true };
	},
	// The author retracting a comment of their own.
	deleteComment: async ({ params, request, locals }) => {
		await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		const commentId = String(data.get('commentId') ?? '');
		if (!isUuid(commentId)) return fail(400, { message: 'That comment does not exist.' });
		const result = await deleteComment(db, { userId: locals.user!.id }, commentId);
		if (!result.ok) return fail(400, { message: result.reason });
		return { done: true };
	},
	// The author retracting a suggestion of their own while it is still pending.
	deleteSuggestion: async ({ params, request, locals }) => {
		await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		const suggestionId = String(data.get('suggestionId') ?? '');
		if (!isUuid(suggestionId)) return fail(400, { message: 'That suggestion does not exist.' });
		const result = await deleteSuggestion(db, { userId: locals.user!.id }, suggestionId);
		if (!result.ok) return fail(400, { message: result.reason });
		return { done: true };
	}
};
