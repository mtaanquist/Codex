import { eq } from 'drizzle-orm';
import type { Database } from './auth.ts';
import { isUniqueViolation } from './db-errors.ts';
import { stories } from './db/schema.ts';
import { markMentionsStale } from './scene-lifecycle.ts';
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
// leaves it alone. Arcs and the enrich pass name the story they quote, so a
// rename marks what its scenes mention, in the same transaction (story row
// first, then entities).
export async function saveStoryDetails(
	db: Database,
	ownerId: string,
	story: { id: string; title: string; slug: string },
	details: StoryDetails
): Promise<string> {
	const renamed = details.title !== story.title;
	const save = async (slug: string) => {
		await db.transaction(async (tx) => {
			await tx
				.update(stories)
				.set({ ...details, slug })
				.where(eq(stories.id, story.id));
			if (renamed) await markMentionsStale(tx, { storyId: story.id }, { enrich: true });
		});
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
