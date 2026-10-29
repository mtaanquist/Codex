import type { Action } from 'svelte/action';

export type DismissParams = {
	// Closes the menu or popover.
	close: () => void;
	// Active only while the menu is open; pass the open flag when the action
	// sits on an always-rendered container. Defaults to true, for elements
	// that only exist while open.
	enabled?: boolean;
	// Where focus returns on Escape (the editor, the trigger button). Runs
	// before close, while the menu is still rendered.
	refocus?: () => void;
};

// The one "close on outside pointerdown or Escape" behaviour for menus and
// popovers. Attach to the element whose inside should not dismiss (include
// the trigger, or a click on it closes and immediately reopens the menu).
// Escape stops propagating, so an outer Escape handler (focus mode, a parent
// menu) does not also fire on the same press.
export const dismiss: Action<HTMLElement, DismissParams> = (node, params) => {
	let current = params;
	// A modal opened over this menu owns its own Escape. Clicks are ignored
	// only on the confirm prompt (backdrop included, `data-over-menus`), which a
	// menu item opens and whose answer submits a form inside the menu; a click
	// in any other modal still closes the menu.
	function inside(target: EventTarget | null, selector: string): boolean {
		const above = (target as Element | null)?.closest?.(selector);
		return !!above && !above.contains(node);
	}
	function onPointerDown(event: PointerEvent) {
		if (current.enabled === false) return;
		if (inside(event.target, '[data-over-menus]')) return;
		if (!node.contains(event.target as Node)) current.close();
	}
	function onKeydown(event: KeyboardEvent) {
		if (current.enabled === false) return;
		if (event.key !== 'Escape') return;
		if (inside(event.target, '[aria-modal="true"]')) return;
		event.preventDefault();
		event.stopPropagation();
		current.refocus?.();
		current.close();
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
