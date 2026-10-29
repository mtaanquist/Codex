import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { ownedStory } from '$lib/server/story-access';
import { loadSceneMeta, loadStoryLive, type StoryLiveResponse } from '$lib/server/story-live';
import { isUuid } from '$lib/slug';

// The slice of the story page a save changes, read after each save instead of
// reloading the whole page.
export const GET: RequestHandler = async ({ params, url, locals }) => {
	const { story, universe } = await ownedStory(params.id, locals.user!.id);
	const sceneParam = url.searchParams.get('scene');
	const sceneMeta =
		sceneParam && isUuid(sceneParam) ? await loadSceneMeta(db, story.id, sceneParam) : null;
	const live = await loadStoryLive(db, {
		storyId: story.id,
		universeId: universe.id,
		sceneId: sceneMeta ? sceneParam : null
	});
	return Response.json({ ...live, sceneMeta } satisfies StoryLiveResponse);
};
