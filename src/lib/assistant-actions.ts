// Client-side Assistant actions shared by the story page and the command
// palette, so the fetch-and-feedback logic lives once. Server-side gating is
// re-checked by every endpoint; these just drive the requests.
import { goto } from '$app/navigation';
import { apiErrorMessage } from '$lib/format';

// Asks the Assistant to review one scene inline. Stages comments and
// suggested edits, then opens the review page when anything was staged.
export type SceneReviewFocus = 'notes' | 'mechanics' | 'prose' | 'lore' | 'full';

export async function reviewSceneWithAssistant(
	sceneId: string,
	reviewHref: string,
	focus: SceneReviewFocus = 'notes'
): Promise<void> {
	const response = await fetch('/api/assistant/review', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ sceneId, focus })
	});
	if (!response.ok) {
		alert(await apiErrorMessage(response, 'The Assistant could not review the scene.'));
		return;
	}
	const { staged } = (await response.json()) as { staged: number };
	if (staged > 0) {
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- app path from a slug
		await goto(reviewHref);
	} else {
		alert('The Assistant read the scene and had no notes to add.');
	}
}

// Kicks off the background summary pass; the writer is notified when it ends.
export async function startSummariesJob(storyId: string): Promise<void> {
	const response = await fetch('/api/assistant/summaries-job', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ storyId })
	});
	if (!response.ok) {
		alert(await apiErrorMessage(response, 'Could not start the summary pass.'));
		return;
	}
	alert(
		'The Assistant is updating your scene and chapter summaries in the background. You will be notified when it is done.'
	);
}
