import type { SubmitFunction } from '@sveltejs/kit';
import { browser } from '$app/environment';

// Helpers for settings forms that save on change instead of with a button. A
// select or checkbox saves at once; a text field saves when it loses focus
// (the native change event fires on blur). Shared by the account and story
// settings pages.

// Use with `use:enhance`. reset:false leaves each field as the writer left it
// while the reload refreshes the saved values across the page.
export const autosaveSubmit: SubmitFunction =
	() =>
	async ({ update }) =>
		update({ reset: false });

// Use as a form's onchange handler: any control change submits the form.
export function autosubmitForm(event: Event & { currentTarget: HTMLFormElement }) {
	event.currentTarget.requestSubmit();
}

// Save a still-focused field before navigating away or closing the page, so
// leaving from inside a field does not lose the edit. Wire it to
// `beforeNavigate` and to the window's pagehide event.
export function flushFocusedField() {
	if (browser) (document.activeElement as HTMLElement | null)?.blur?.();
}
