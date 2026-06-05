import { fail, redirect } from '@sveltejs/kit';
import { asc, desc, eq, inArray } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db, isUniqueViolation } from '$lib/server/db';
import { entityCategories, stories, universes } from '$lib/server/db/schema';
import { uniqueSlug } from '$lib/server/slugs';

export const load: PageServerLoad = async ({ locals }) => {
	// Signed-out visitors get the landing page; no data to load for it.
	if (!locals.user) {
		return { user: null, universes: [], stories: [], isAdmin: false };
	}
	const user = locals.user;
	const list = await db
		.select()
		.from(universes)
		.where(eq(universes.ownerId, user.id))
		.orderBy(desc(universes.updatedAt));
	const storyList =
		list.length === 0
			? []
			: await db
					.select({
						id: stories.id,
						slug: stories.slug,
						title: stories.title,
						brief: stories.brief,
						universeId: stories.universeId
					})
					.from(stories)
					.where(
						inArray(
							stories.universeId,
							list.map((universe) => universe.id)
						)
					)
					.orderBy(asc(stories.positionInSeries), asc(stories.createdAt));

	return {
		user,
		universes: list,
		stories: storyList,
		isAdmin: user.role === 'admin'
	};
};

export const actions: Actions = {
	createUniverse: async ({ request, locals }) => {
		// The route is public for the landing page; the action is not.
		if (!locals.user) redirect(303, '/login');
		const data = await request.formData();
		const name = String(data.get('name') ?? '').trim();
		if (!name) {
			return fail(400, { scope: 'universe', message: 'Give the universe a name.' });
		}
		const create = (slug: string) =>
			db.transaction(async (tx) => {
				const [row] = await tx
					.insert(universes)
					.values({ ownerId: locals.user!.id, name, slug })
					.returning();
				// Every universe starts with one lore category; users rename and
				// extend from there.
				await tx.insert(entityCategories).values({
					universeId: row.id,
					ownerId: locals.user!.id,
					name: 'Lore',
					sortOrder: 0
				});
				return row;
			});
		let universe;
		try {
			universe = await create(await uniqueSlug(db, 'universes', locals.user.id, name, 'universe'));
		} catch (err) {
			// A concurrent create took the slug between the pick and the insert.
			if (!isUniqueViolation(err)) throw err;
			universe = await create(await uniqueSlug(db, 'universes', locals.user.id, name, 'universe'));
		}
		redirect(303, `/universes/${universe.slug}`);
	}
};
