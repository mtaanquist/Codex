import type { Action } from 'svelte/action';

const TABBABLE = [
	'a[href]',
	'button:not([disabled])',
	'input:not([disabled]):not([type="hidden"])',
	'select:not([disabled])',
	'textarea:not([disabled])',
	'[tabindex]:not([tabindex="-1"])',
	'[contenteditable="true"]'
].join(', ');

// Where Tab should send focus to keep it inside the dialog, given the focused
// element's index among `count` tabbable elements (-1 when the panel itself or
// nothing tabbable has focus). Null means the browser's own move stays inside.
export function trapTarget(index: number, count: number, backwards: boolean): number | null {
	if (count === 0) return null;
	if (index < 0) return backwards ? count - 1 : 0;
	if (backwards && index === 0) return count - 1;
	if (!backwards && index === count - 1) return 0;
	return null;
}

export type ModalParams = {
	// Closes the dialog. Escape calls it; a dialog that may refuse to close
	// (unsaved or invalid fields) decides that inside it.
	close: () => void;
	// A selector for what takes focus on open; the panel itself otherwise.
	initialFocus?: string;
};

// A radio group is one tab stop: its checked radio, or its first when none is
// checked. Listing every radio would let the browser's own move leave the panel.
function radioStop(radio: HTMLInputElement, all: HTMLElement[]): boolean {
	const group = all.filter(
		(el): el is HTMLInputElement =>
			el instanceof HTMLInputElement &&
			el.type === 'radio' &&
			el.name === radio.name &&
			el.form === radio.form
	);
	const checked = group.find((el) => el.checked);
	return radio === (checked ?? group[0]);
}

function tabbables(node: HTMLElement): HTMLElement[] {
	const all = [...node.querySelectorAll<HTMLElement>(TABBABLE)].filter(
		(el) => el.tabIndex >= 0 && el.getClientRects().length > 0
	);
	return all.filter(
		(el) =>
			!(el instanceof HTMLInputElement && el.type === 'radio' && el.name) || radioStop(el, all)
	);
}

// The one modal keyboard contract, on the role="dialog" panel of a modal that
// renders only while open: focus moves in on open, Tab and Shift+Tab cycle
// inside the panel, Escape closes it, and focus returns to whatever opened it.
export const modal: Action<HTMLElement, ModalParams> = (node, params) => {
	let current = params;
	const opener = document.activeElement as HTMLElement | null;

	if (!node.hasAttribute('tabindex')) node.tabIndex = -1;
	const first = current.initialFocus ? node.querySelector<HTMLElement>(current.initialFocus) : null;
	(first ?? node).focus();

	function onKeydown(event: KeyboardEvent) {
		// Keys from inside the panel, or from <body> when the focused control was
		// removed or disabled under it; anything else belongs to someone else.
		const target = event.target as Node;
		if (target !== document.body && !node.contains(target)) return;
		if (event.key === 'Escape') {
			// Stop here so a page-level Escape (leaving focus mode) does not
			// also fire.
			event.preventDefault();
			event.stopPropagation();
			current.close();
			return;
		}
		if (event.key !== 'Tab') return;
		const list = tabbables(node);
		const at = list.indexOf(document.activeElement as HTMLElement);
		const to = trapTarget(at, list.length, event.shiftKey);
		if (list.length === 0) {
			event.preventDefault();
			return;
		}
		if (to === null) return;
		event.preventDefault();
		list[to].focus();
	}

	// On the document, not the panel, so focus lost to <body> is still caught.
	document.addEventListener('keydown', onKeydown);
	return {
		update(next: ModalParams) {
			current = next;
		},
		destroy() {
			document.removeEventListener('keydown', onKeydown);
			// Return focus only if it is still in the dialog (or lost): a
			// command run from the dialog may have moved it on purpose.
			const active = document.activeElement;
			const lost = !active || active === document.body || node.contains(active);
			if (lost && opener?.isConnected) opener.focus();
		}
	};
};
