import { fail, redirect } from '@sveltejs/kit';
import { asc, desc, eq, inArray } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { entityCategories, stories, universes } from '$lib/server/db/schema';

export const load: PageServerLoad = async ({ locals }) => {
	const user = locals.user!;
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
		const data = await request.formData();
		const name = String(data.get('name') ?? '').trim();
		if (!name) {
			return fail(400, { scope: 'universe', message: 'Give the universe a name.' });
		}
		const universe = await db.transaction(async (tx) => {
			const [row] = await tx
				.insert(universes)
				.values({ ownerId: locals.user!.id, name })
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
		redirect(303, `/universes/${universe.id}`);
	}
};
