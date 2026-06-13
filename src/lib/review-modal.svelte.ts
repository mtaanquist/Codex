// Cross-surface state for the review modal: the sidebar row menu, the command
// palette, the review pane, and the chat's /review command all ask for it, and
// the page that holds the story context renders ReviewModal and supplies the
// chapters and scenes. Lives here, like assistant.svelte.ts, so surfaces outside
// the page tree can open it too.
import type { ReviewLevel } from './review-shape';

export type ReviewModalRequest = {
	// The level to preselect; the modal narrows the available levels to what the
	// context allows (a scene id enables "this scene", a chapter id "this chapter").
	level?: ReviewLevel;
	sceneId?: string;
	chapterId?: string;
};

export const reviewModal = $state<{ open: boolean; request: ReviewModalRequest }>({
	open: false,
	request: {}
});

export function openReviewModal(request: ReviewModalRequest = {}): void {
	reviewModal.request = request;
	reviewModal.open = true;
}

export function closeReviewModal(): void {
	reviewModal.open = false;
}
