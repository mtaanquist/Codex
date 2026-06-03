import { error } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { stories, universes } from '$lib/server/db/schema';

export const load: PageServerLoad = async ({ params, locals }) => {
	const [row] = await db
		.select({ story: stories, universe: universes })
		.from(stories)
		.innerJoin(universes, eq(stories.universeId, universes.id))
		.where(and(eq(stories.id, params.id), eq(stories.ownerId, locals.user!.id)));
	if (!row) error(404, 'Story not found');
	return { ...row, user: locals.user! };
};
