import type { Database } from './auth';
import { isUniqueViolation } from './db';
import { stories } from './db/schema';
import { uniqueSlug } from './slugs';

// Creates a story with a readable slug, shared by the library's new-story
// card and the universe plan board. Retries once when a concurrent create
// takes the picked slug between the pick and the insert.
export async function createStoryInUniverse(
	db: Database,
	ownerId: string,
	universeId: string,
	title: string
) {
	const create = (slug: string) =>
		db.insert(stories).values({ universeId, ownerId, title, slug }).returning();
	try {
		const [story] = await create(await uniqueSlug(db, 'stories', ownerId, title, 'story'));
		return story;
	} catch (err) {
		if (!isUniqueViolation(err)) throw err;
		const [story] = await create(await uniqueSlug(db, 'stories', ownerId, title, 'story'));
		return story;
	}
}
