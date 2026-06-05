import { fail } from '@sveltejs/kit';
import { ownedStory } from '$lib/server/story-access';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import {
	addComment,
	decideSuggestion,
	listSuggestions,
	listThreads,
	setThreadResolved
} from '$lib/server/review';
import { gatherStory } from '$lib/server/export';
import { reanchorRange } from '$lib/review-anchor';
import { queueSceneMentions } from '$lib/server/jobs';

// The author's side of a review: every thread guests have left on the
// story, against the current text, with reply and resolve.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const load: PageServerLoad = async ({ params, locals }) => {
	const { story } = await ownedStory(params.id, locals.user!.id);
	const content = await gatherStory(db, story);
	return {
		story: { id: story.id, slug: story.slug, title: story.title, universeId: story.universeId },
		chapters: content.chapters,
		scenes: content.scenes.map((scene) => ({
			id: scene.id!,
			chapterId: scene.chapterId,
			title: scene.title,
			bodyMd: scene.bodyMd
		})),
		threads: await listThreads(db, story.id, reanchorRange),
		suggestions: await listSuggestions(db, story.id)
	};
};

export const actions: Actions = {
	reply: async ({ params, request, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		const threadId = String(data.get('threadId') ?? '');
		if (!UUID.test(threadId)) return fail(400, { message: 'That thread does not exist.' });
		const result = await addComment(db, {
			storyId: story.id,
			threadId,
			author: { userId: locals.user!.id },
			body: String(data.get('body') ?? '')
		});
		if (!result.ok) return fail(400, { message: result.reason });
		return { done: true };
	},
	resolve: async ({ params, request, locals }) => {
		await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		const threadId = String(data.get('threadId') ?? '');
		if (!UUID.test(threadId) || !(await setThreadResolved(db, locals.user!.id, threadId, true))) {
			return fail(400, { message: 'That thread could not be resolved.' });
		}
		return { done: true };
	},
	reopen: async ({ params, request, locals }) => {
		await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		const threadId = String(data.get('threadId') ?? '');
		if (!UUID.test(threadId) || !(await setThreadResolved(db, locals.user!.id, threadId, false))) {
			return fail(400, { message: 'That thread could not be reopened.' });
		}
		return { done: true };
	},
	acceptSuggestion: async ({ params, request, locals }) => {
		await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		const suggestionId = String(data.get('suggestionId') ?? '');
		if (!UUID.test(suggestionId)) return fail(400, { message: 'That suggestion does not exist.' });
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
		if (!UUID.test(suggestionId)) return fail(400, { message: 'That suggestion does not exist.' });
		const result = await decideSuggestion(db, locals.user!.id, suggestionId, false);
		if (!result.ok) return fail(400, { message: result.reason });
		return { done: true };
	}
};
