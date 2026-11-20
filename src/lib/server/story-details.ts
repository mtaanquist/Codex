import { eq } from 'drizzle-orm';
import type { Database } from './auth.ts';
import { isUniqueViolation } from './db-errors.ts';
import { stories } from './db/schema.ts';
import { uniqueSlug } from './slugs.ts';

export type StoryDetails = {
	title: string;
	author: string | null;
	brief: string | null;
	descriptionMd: string | null;
	styleNotes: string | null;
	coverColor: string | null;
};

// Saves the story settings' details form and returns the story's slug. The
// slug follows the title: a rename moves the story's URL, an unchanged title
// leaves it alone.
export async function saveStoryDetails(
	db: Database,
	ownerId: string,
	story: { id: string; title: string; slug: string },
	details: StoryDetails
): Promise<string> {
	const renamed = details.title !== story.title;
	const save = async (slug: string) => {
		await db
			.update(stories)
			.set({ ...details, slug })
			.where(eq(stories.id, story.id));
		return slug;
	};
	const freshSlug = () => uniqueSlug(db, 'stories', ownerId, details.title, 'story');
	try {
		return await save(renamed ? await freshSlug() : story.slug);
	} catch (err) {
		// A concurrent create took the slug between the pick and the update.
		if (!isUniqueViolation(err)) throw err;
		return await save(await freshSlug());
	}
}
