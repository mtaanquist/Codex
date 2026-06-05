import { error, fail } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { stories } from '$lib/server/db/schema';
import { addComment, listThreads, setThreadResolved } from '$lib/server/review';
import { gatherStory } from '$lib/server/export';
import { reanchorRange } from '$lib/review-anchor';

// The author's side of a review: every thread guests have left on the
// story, against the current text, with reply and resolve.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function ownedStory(storyId: string, userId: string) {
	const [story] = await db
		.select()
		.from(stories)
		.where(and(eq(stories.id, storyId), eq(stories.ownerId, userId)));
	if (!story) error(404, 'Story not found');
	return story;
}

export const load: PageServerLoad = async ({ params, locals }) => {
	const story = await ownedStory(params.id, locals.user!.id);
	const content = await gatherStory(db, story);
	return {
		story: { id: story.id, title: story.title, universeId: story.universeId },
		chapters: content.chapters,
		scenes: content.scenes.map((scene) => ({
			id: scene.id!,
			chapterId: scene.chapterId,
			title: scene.title,
			bodyMd: scene.bodyMd
		})),
		threads: await listThreads(db, story.id, reanchorRange)
	};
};

export const actions: Actions = {
	reply: async ({ params, request, locals }) => {
		const story = await ownedStory(params.id, locals.user!.id);
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
	}
};
