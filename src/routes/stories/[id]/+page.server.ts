import { error, fail, redirect } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { stories, universes } from '$lib/server/db/schema';

async function ownedStory(storyId: string, userId: string) {
	const [row] = await db
		.select({ story: stories, universe: universes })
		.from(stories)
		.innerJoin(universes, eq(stories.universeId, universes.id))
		.where(and(eq(stories.id, storyId), eq(stories.ownerId, userId)));
	if (!row) error(404, 'Story not found');
	return row;
}

export const load: PageServerLoad = async ({ params, locals }) => {
	return await ownedStory(params.id, locals.user!.id);
};

export const actions: Actions = {
	update: async ({ request, params, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		const title = String(data.get('title') ?? '').trim();
		const author = String(data.get('author') ?? '').trim() || null;
		const brief = String(data.get('brief') ?? '').trim() || null;
		const descriptionMd = String(data.get('description') ?? '').trim() || null;
		if (!title) {
			return fail(400, { action: 'update', message: 'The story needs a title.' });
		}
		await db
			.update(stories)
			.set({ title, author, brief, descriptionMd })
			.where(eq(stories.id, story.id));
		return { action: 'update', saved: true };
	},
	delete: async ({ params, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		await db.delete(stories).where(eq(stories.id, story.id));
		redirect(303, `/universes/${story.universeId}`);
	}
};
