// Client-side scene operations shared by the story page's menus and proposal
// cards, in the spirit of assistant-actions.ts: the fetch contracts live
// once, and the callers decide what to do with the result (navigate, alert,
// reopen a card). Every endpoint re-checks ownership server-side.
import { apiErrorMessage } from '$lib/format';

type Result<T> = ({ ok: true } & T) | { ok: false; message: string };

async function post<T>(url: string, body: unknown, fallback: string): Promise<Result<T>> {
	const response = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
	if (!response.ok) return { ok: false, message: await apiErrorMessage(response, fallback) };
	return { ok: true, ...((await response.json()) as T) };
}

// Merges the picked scenes into the earliest of them (story order).
export async function mergeScenes(storyId: string, sceneIds: string[]) {
	return await post<{ targetSceneId: string }>(
		`/api/stories/${storyId}/merge-scenes`,
		{ sceneIds },
		'Could not merge the scenes.'
	);
}

// Copies a scene in full directly after itself.
export async function duplicateScene(storyId: string, sceneId: string) {
	return await post<{ newSceneId: string }>(
		`/api/stories/${storyId}/duplicate-scene`,
		{ sceneId },
		'Could not duplicate the scene.'
	);
}

// Splits a scene at a character offset, or before an exact passage (the
// Assistant's proposals); the server re-locates the passage against the
// stored text, so flush any pending autosave first.
export async function splitScene(sceneId: string, at: { offset: number } | { before: string }) {
	return await post<{ newSceneId: string; splitSceneId: string }>(
		`/api/scenes/${sceneId}/split`,
		at,
		'Could not split the scene.'
	);
}

// Records a proposal card's outcome on its stored chat turn, so the card
// stays decided (or reopens after a revert) across reloads. Best effort:
// the split or merge itself already landed.
export function persistProposalState(
	storyId: string,
	proposal: { sceneId: string; before: string },
	confirmed: { splitSceneId: string; newSceneId: string } | null
) {
	void fetch(`/api/stories/${storyId}/assistant-proposal`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ sceneId: proposal.sceneId, before: proposal.before, confirmed })
	}).catch(() => {});
}
