// Focus mode on the story write page hides the chrome around the prose.
// The flag lives here so the command palette can toggle it too; the page
// turns it off when you leave.

export const focusMode = $state<{ on: boolean }>({ on: false });
