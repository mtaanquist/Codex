import { error } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { db } from './db';
import { stories, universes } from './db/schema';
import { isUuid } from '../slug';

// Loads a story with its universe, by id or slug, 404ing unless the user
// owns it. Shared by the story routes. Slugs are unique per owner, so the
// session scopes the lookup; ids stay valid forever.
export async function ownedStory(ref: string, userId: string) {
	const byRef = isUuid(ref) ? eq(stories.id, ref) : eq(stories.slug, ref);
	const [row] = await db
		.select({ story: stories, universe: universes })
		.from(stories)
		.innerJoin(universes, eq(stories.universeId, universes.id))
		.where(and(byRef, eq(stories.ownerId, userId)));
	if (!row) error(404, 'Story not found');
	return row;
}
