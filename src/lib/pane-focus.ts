// Pane tabs on a narrow window show one pane at a time. If a switch hid the
// focused control (or a navigation reset focus to the page), move focus to
// the pane now shown so the next Tab starts there. Wide windows show every
// pane, so nothing moves there.

// Rendered at all; checkVisibility() is missing before Safari 17.4.
const isShown = (el: Element) => el.getClientRects().length > 0;

export function focusShownPane(tabs: HTMLElement | undefined, pane: HTMLElement | undefined) {
	if (!tabs || !isShown(tabs)) return;
	const focused = document.activeElement;
	if (!(focused instanceof HTMLElement) || focused === document.body || !isShown(focused))
		pane?.focus({ preventScroll: true });
}
