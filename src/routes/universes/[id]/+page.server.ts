import { fail, redirect } from '@sveltejs/kit';
import { asc, eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { stories, universes } from '$lib/server/db/schema';
import { ownedUniverse } from '$lib/server/universe-access';
import { universeTimeline } from '$lib/server/revisions';

export const load: PageServerLoad = async ({ params, locals }) => {
	const universe = await ownedUniverse(params.id, locals.user!.id);
	const storyList = await db
		.select()
		.from(stories)
		.where(eq(stories.universeId, universe.id))
		.orderBy(asc(stories.positionInSeries), asc(stories.createdAt));
	const timeline = await universeTimeline(db, universe.id, 30);
	return { universe, stories: storyList, timeline };
};

export const actions: Actions = {
	createStory: async ({ request, params, locals }) => {
		const universe = await ownedUniverse(params.id, locals.user!.id);
		const data = await request.formData();
		const title = String(data.get('title') ?? '').trim();
		if (!title) {
			return fail(400, { action: 'createStory', message: 'Give the story a title.' });
		}
		const [story] = await db
			.insert(stories)
			.values({ universeId: universe.id, ownerId: locals.user!.id, title })
			.returning();
		redirect(303, `/stories/${story.id}`);
	},
	update: async ({ request, params, locals }) => {
		const universe = await ownedUniverse(params.id, locals.user!.id);
		const data = await request.formData();
		const name = String(data.get('name') ?? '').trim();
		const descriptionMd = String(data.get('description') ?? '').trim() || null;
		if (!name) {
			return fail(400, { action: 'update', message: 'The universe needs a name.' });
		}
		await db.update(universes).set({ name, descriptionMd }).where(eq(universes.id, universe.id));
		return { action: 'update', saved: true };
	},
	delete: async ({ params, locals }) => {
		const universe = await ownedUniverse(params.id, locals.user!.id);
		const ownedStories = await db
			.select({ id: stories.id })
			.from(stories)
			.where(eq(stories.universeId, universe.id));
		if (ownedStories.length > 0) {
			return fail(400, {
				action: 'delete',
				message: 'Delete the stories in this universe first.'
			});
		}
		await db.delete(universes).where(eq(universes.id, universe.id));
		redirect(303, '/');
	}
};
