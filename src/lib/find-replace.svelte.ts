// Cross-surface state for find and replace across a chapter or the story: the
// editor's Ctrl+F panel, the sidebar's chapter menu and the command palette
// ask for it, and the story page renders FindReplaceModal.

export type FindReplaceRequest = {
	// The chapter to search, or null for the whole story.
	chapterId: string | null;
	find?: string;
	matchCase?: boolean;
	wholeWord?: boolean;
};

export const findReplace = $state<{ open: boolean; request: FindReplaceRequest }>({
	open: false,
	request: { chapterId: null }
});

export function openFindReplace(request: FindReplaceRequest): void {
	findReplace.request = request;
	findReplace.open = true;
}

export function closeFindReplace(): void {
	findReplace.open = false;
}
