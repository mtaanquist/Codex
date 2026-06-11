import type { Action } from 'svelte/action';

export type DismissParams = {
	// Closes the menu or popover.
	close: () => void;
	// Active only while the menu is open; pass the open flag when the action
	// sits on an always-rendered container. Defaults to true, for elements
	// that only exist while open.
	enabled?: boolean;
	// Where focus returns on Escape (the editor, the trigger button).
	refocus?: () => void;
};

// The one "close on outside pointerdown or Escape" behaviour for menus and
// popovers. Attach to the element whose inside should not dismiss (include
// the trigger, or a click on it closes and immediately reopens the menu).
// Escape stops propagating, so an outer Escape handler (focus mode, a parent
// menu) does not also fire on the same press.
export const dismiss: Action<HTMLElement, DismissParams> = (node, params) => {
	let current = params;
	function onPointerDown(event: PointerEvent) {
		if (current.enabled === false) return;
		if (!node.contains(event.target as Node)) current.close();
	}
	function onKeydown(event: KeyboardEvent) {
		if (current.enabled === false) return;
		if (event.key !== 'Escape') return;
		event.preventDefault();
		event.stopPropagation();
		current.close();
		current.refocus?.();
	}
	document.addEventListener('pointerdown', onPointerDown, true);
	document.addEventListener('keydown', onKeydown, true);
	return {
		update(next: DismissParams) {
			current = next;
		},
		destroy() {
			document.removeEventListener('pointerdown', onPointerDown, true);
			document.removeEventListener('keydown', onKeydown, true);
		}
	};
};
