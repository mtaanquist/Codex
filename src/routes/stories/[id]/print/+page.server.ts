import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { ownedStory } from '$lib/server/story-access';
import { gatherStory } from '$lib/server/export';
import { storyPageSetup } from '$lib/server/page-setup';

// Data for the print-optimised view; "Export PDF" is the browser's print
// dialog over this page.
export const load: PageServerLoad = async ({ params, locals }) => {
	const { story } = await ownedStory(params.id, locals.user!.id);
	const { chapters, scenes } = await gatherStory(db, story);
	return { story, chapters, scenes, pageSetup: await storyPageSetup(db, story.id) };
};
