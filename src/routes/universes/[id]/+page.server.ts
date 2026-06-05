import { fail, redirect } from '@sveltejs/kit';
import { asc, eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { stories, universes } from '$lib/server/db/schema';
import { ownedUniverse } from '$lib/server/universe-access';
import { slugTaken, uniqueSlug } from '$lib/server/slugs';
import { isValidSlug } from '$lib/slug';
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
		const slug = await uniqueSlug(db, 'stories', locals.user!.id, title, 'story');
		const [story] = await db
			.insert(stories)
			.values({ universeId: universe.id, ownerId: locals.user!.id, title, slug })
			.returning();
		redirect(303, `/stories/${story.slug}`);
	},
	update: async ({ request, params, locals }) => {
		const universe = await ownedUniverse(params.id, locals.user!.id);
		const data = await request.formData();
		const name = String(data.get('name') ?? '').trim();
		const slug = String(data.get('slug') ?? '').trim();
		const descriptionMd = String(data.get('description') ?? '').trim() || null;
		if (!name) {
			return fail(400, { action: 'update', message: 'The universe needs a name.' });
		}
		if (!isValidSlug(slug)) {
			return fail(400, {
				action: 'update',
				message: 'The slug can only use lowercase letters, numbers, and hyphens.'
			});
		}
		if (
			slug !== universe.slug &&
			(await slugTaken(db, 'universes', locals.user!.id, slug, universe.id))
		) {
			return fail(400, { action: 'update', message: 'Another universe already uses that slug.' });
		}
		await db
			.update(universes)
			.set({ name, slug, descriptionMd })
			.where(eq(universes.id, universe.id));
		// A changed slug moves this page's own URL.
		if (slug !== universe.slug) redirect(303, `/universes/${slug}`);
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
