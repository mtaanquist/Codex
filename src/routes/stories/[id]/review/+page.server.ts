import { fail } from '@sveltejs/kit';
import { isUuid } from '$lib/slug';
import { ownedStory } from '$lib/server/story-access';
import { readingPageRef } from '$lib/server/publish';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import {
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
import { storyPageSetup } from '$lib/server/page-setup';
import { reviewMentionData } from '$lib/server/mention-entities';
import { createAnchorMapper } from '$lib/review-anchor';
import { queueSceneMentions } from '$lib/server/jobs';
import { assistantLayout, saveStoryLlmOverride } from '$lib/server/llm/config';
import { listChat } from '$lib/server/llm/chat-history';
import { notifySuggestionDiscussion, notifyThreadReviewers } from '$lib/server/notify';
import { teaser } from '$lib/notifications';
import { listTrashedScenes } from '$lib/server/scene-lifecycle';
import { sceneManageActions } from '$lib/server/scene-manage-actions';

// The author's side of a review: every thread guests have left on the
// story, against the current text, with reply and resolve.

export const load: PageServerLoad = async ({ params, locals }) => {
	const { story, universe } = await ownedStory(params.id, locals.user!.id);
	// One parallel wave rather than a serial chain: the review page is as hot a
	// navigation as the editor. The author's review takes the full cast
	// (restrictToMentioned is false), so reviewMentionData needs no scene ids and
	// nothing here waits on gatherStory.
	// Threads and suggestions re-anchor against the same scene revisions, so one
	// mapper covers both and each revision is diffed once for the page.
	const anchors = createAnchorMapper();
	const [
		content,
		mentions,
		trashedScenes,
		threads,
		suggestions,
		preferences,
		pageSetup,
		assistant
	] = await Promise.all([
		gatherStory(db, story),
		reviewMentionData(db, {
			universeId: story.universeId,
			storyId: story.id,
			sceneIds: [],
			restrictToMentioned: false
		}),
		listTrashedScenes(db, story.id),
		listThreads(db, story.id, anchors.range, { userId: locals.user!.id }),
		listSuggestions(db, story.id, { userId: locals.user!.id }, anchors),
		storyPreferences(db, locals.user!.id, story.id),
		storyPageSetup(db, story.id),
		assistantLayout(db, locals.user!.id, story.id)
	]);
	const scenes = content.scenes.map((scene) => ({
		id: scene.id!,
		chapterId: scene.chapterId,
		title: scene.title,
		status: scene.status,
		bodyMd: scene.bodyMd
	}));
	// The stored conversation seeds the review page's Assistant tab, the same
	// transcript as the Write editor's; nothing to load when the tab is off.
	const assistantChat = assistant.tabEnabled
		? await listChat(db, locals.user!.id, { storyId: story.id })
		: [];
	return {
		story: { id: story.id, slug: story.slug, title: story.title, universeId: story.universeId },
		universe: { slug: universe.slug, name: universe.name },
		reading: await readingPageRef(db, story.id),
		chapters: content.chapters,
		scenes,
		// The author's sidebar manages structure here too, trash included.
		trashedScenes,
		threads,
		suggestions,
		mentionEntities: mentions.entities,
		mentionMembers: mentions.storyMembers,
		mentionPins: mentions.pins,
		// The editor view toggles, shared with the Write editor.
		preferences,
		// The default text alignment for the editable centre, like the Write editor.
		pageSetup,
		// Whether the Assistant answers in its threads here, and under what name.
		assistant,
		// The stored chat transcript for the Assistant tab.
		assistantChat
	};
};

export const actions: Actions = {
	// The sidebar's chapter and scene management, shared with the Write route;
	// the outline posts to these relative actions. They land back on the review
	// page rather than the editor.
	...sceneManageActions((slug) => `/stories/${slug}/review`),
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
	},
	// The Assistant tab's mute and un-mute, the same per-story override as the
	// Write editor's; the gate re-renders on the returned scope.
	muteAssistant: async ({ params, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		await saveStoryLlmOverride(db, story.id, { enabled: false });
		return { scope: 'assistant-mute' };
	},
	unmuteAssistant: async ({ params, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		await saveStoryLlmOverride(db, story.id, { enabled: null });
		return { scope: 'assistant-mute' };
	}
};
