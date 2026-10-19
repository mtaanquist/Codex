import { invalidate } from '$app/navigation';

// Set just before invalidating the live slice, so +page.ts knows to fetch it.
// Any other rerun (a navigation, invalidateAll) takes the server data as is.
export const liveRefresh = { pending: false };

export const STORY_LIVE = 'story:live';

// Re-reads the parts of the page a save changes (counts, to-dos, the open
// scene's history and mentions) without running the full page load.
export function refreshStoryLive(): Promise<void> {
	liveRefresh.pending = true;
	return invalidate(STORY_LIVE);
}
