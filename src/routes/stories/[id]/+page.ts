import { isRedirect, redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import type { StoryLiveResponse } from '#lib/server/story-live';
import { liveRefresh, STORY_LIVE } from './live';

type Data = Parameters<PageLoad>[0]['data'];

// The last live read, kept with the server data it was laid over, so a rerun
// that was not asked to fetch does not fall back to older counts.
let last: { base: Data; merged: Data } | null = null;

export const load: PageLoad = async ({ data, depends, fetch }) => {
	depends(STORY_LIVE);
	const previous = last?.base === data ? last.merged : data;
	if (!liveRefresh.pending) return previous;
	liveRefresh.pending = false;
	const scene = data.selectedScene;
	const query = scene ? `?scene=${scene.id}` : '';
	let live: StoryLiveResponse;
	try {
		const response = await fetch(`/api/stories/${data.story.id}/live${query}`);
		// A signed-out session is redirected to the sign-in page; go there, the
		// way a full page load would.
		if (response.redirected) redirect(303, new URL(response.url).pathname);
		if (!response.ok) return previous;
		live = (await response.json()) as StoryLiveResponse;
	} catch (err) {
		if (isRedirect(err)) throw err;
		// Offline or a broken reply: keep what the page shows until the next save.
		return previous;
	}
	const { sceneMeta, ...rest } = live;
	// JSON carries the dates as strings; the page compares them as dates.
	const merged: Data = {
		...data,
		...rest,
		sceneRevisions: rest.sceneRevisions.map((r) => ({ ...r, createdAt: new Date(r.createdAt) })),
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
