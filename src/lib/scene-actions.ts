// Client-side scene operations shared by the story page's menus and proposal
// cards, in the spirit of assistant-actions.ts: the fetch contracts live
// once, and the callers decide what to do with the result (navigate, alert,
// reopen a card). Every endpoint re-checks ownership server-side.
import { post } from '#lib/api';

export const SAVE_FAILED =
	'The scene could not be saved, so nothing was changed. If the scene says it was changed in another window, choose Load newer version or Keep mine first. Otherwise, try again in a moment.';

// An open editor that may hold words not yet stored.
export type FlushableEditor = { flushSave: () => Promise<void>; isDirty: () => boolean };

// Lands every pending save before an action that reads the stored text (a
// split, merge or duplicate); false when one failed and its words are still
// only in the browser, so the caller must not go ahead.
export async function flushEditors(editors: FlushableEditor[]): Promise<boolean> {
	await Promise.all(editors.map((editor) => editor.flushSave()));
	// One more pass for an image upload that landed during the first (the
	// writer chose to leave while it was still on its way).
	const dirty = editors.filter((editor) => editor.isDirty());
	await Promise.all(dirty.map((editor) => editor.flushSave()));
	return !editors.some((editor) => editor.isDirty());
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

// Keeps a scene draft the Assistant wrote: into its own scene while that is
// still empty (fill), or as a new scene directly after it (add). text is the
// draft as the writer edited it. The server checks the stored scene, so flush
// any pending autosave first.
export async function landSceneDraft(
	draftId: string,
	action: 'fill' | 'add',
	text: string,
	// The version of the draft the text was edited from.
	base?: string
) {
	return await post<{ sceneId?: string; newSceneId?: string }>(
		`/api/assistant/draft/${draftId}`,
		{ action, text, base },
		'Could not add the draft.'
	);
}

// Splits a scene at a character offset in the text baseHash fingerprints, or
// before an exact passage (the Assistant's proposals); the server re-locates
// the passage against the stored text, so flush any pending autosave first.
export async function splitScene(
	sceneId: string,
	at: { offset: number; baseHash: string } | { before: string }
) {
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
