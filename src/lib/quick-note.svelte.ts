// Cross-surface state for the quick-note jot: the keyboard shortcut and the
// command palette both ask for it, and the page that holds the story context
// renders QuickNote. Lives here, like review-modal.svelte.ts, so surfaces
// outside the page tree can open it too.
export const quickNote = $state<{ open: boolean }>({ open: false });

export function openQuickNote(): void {
	quickNote.open = true;
}

export function closeQuickNote(): void {
	quickNote.open = false;
}
