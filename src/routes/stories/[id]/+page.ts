import type { PageLoad } from './$types';
import type { StoryLiveResponse } from '$lib/server/story-live';
import { liveRefresh, STORY_LIVE } from './live';

type Data = Parameters<PageLoad>[0]['data'];

// The last live read, kept with the server data it was laid over, so a rerun
// that was not asked to fetch does not fall back to older counts.
let last: { base: Data; merged: Data } | null = null;

export const load: PageLoad = async ({ data, depends, fetch }) => {
	depends(STORY_LIVE);
	if (!liveRefresh.pending) return last?.base === data ? last.merged : data;
	liveRefresh.pending = false;
	const scene = data.selectedScene;
	const query = scene ? `?scene=${scene.id}` : '';
	const response = await fetch(`/api/stories/${data.story.id}/live${query}`);
	if (!response.ok) return data;
	const { sceneMeta, ...live } = (await response.json()) as StoryLiveResponse;
	// JSON carries the dates as strings; the page compares them as dates.
	const merged: Data = {
		...data,
		...live,
		sceneRevisions: live.sceneRevisions.map((r) => ({ ...r, createdAt: new Date(r.createdAt) })),
		selectedScene:
			scene && sceneMeta
				? {
						...scene,
						...sceneMeta,
						updatedAt: new Date(sceneMeta.updatedAt),
						mentionsIndexedAt: sceneMeta.mentionsIndexedAt
							? new Date(sceneMeta.mentionsIndexedAt)
							: null
					}
				: scene
	};
	if (typeof window !== 'undefined') last = { base: data, merged };
	return merged;
};
