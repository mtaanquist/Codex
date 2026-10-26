import { tick } from 'svelte';
import type { Action } from 'svelte/action';

export type MenuKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End';

// The item a key moves to among `count` items, wrapping at both ends. -1 is
// "nothing focused yet". Null when there is nowhere to go.
export function nextIndex(current: number, count: number, key: MenuKey): number | null {
	if (count === 0) return null;
	switch (key) {
		case 'Home':
			return 0;
		case 'End':
			return count - 1;
		case 'ArrowDown':
			return current < 0 ? 0 : (current + 1) % count;
		case 'ArrowUp':
			return current < 0 ? count - 1 : (current - 1 + count) % count;
	}
}

const ITEM = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]';

// The enabled items of one menu level, leaving out the items of any submenu
// nested inside it.
function itemsOf(menu: Element): HTMLElement[] {
	return [...menu.querySelectorAll<HTMLElement>(ITEM)].filter(
		(item) =>
			item.closest('[role="menu"]') === menu &&
			!(item as HTMLButtonElement).disabled &&
			item.getAttribute('aria-disabled') !== 'true'
	);
}

function submenuOf(trigger: HTMLElement): HTMLElement | null {
	return trigger.parentElement?.querySelector<HTMLElement>(':scope > [role="menu"]') ?? null;
}

export type MenuParams = {
	// Closes the menu; Tab calls it so focus moves on to the next control.
	close: () => void;
	// Where focus goes before Tab closes the menu (the trigger, the editor),
	// so Tab carries on from there instead of from the removed menu.
	refocus?: () => void;
	// False leaves focus where it is on open: a menu opened with the mouse
	// over the editor must not blur it. Defaults to true.
	focusFirst?: boolean;
};

// Keyboard behaviour for a role="menu" element that renders only while open:
// the first item takes focus on open, the arrow keys move through the items
// and wrap, Home and End jump to the ends, and Tab closes the menu. A submenu
// (an item with aria-haspopup="menu" and its role="menu" sibling) opens with
// ArrowRight and closes with ArrowLeft. Escape and outside clicks belong to
// `dismiss`, which sits beside this.
export const menu: Action<HTMLElement, MenuParams> = (node, params) => {
	let current = params;

	if (current.focusFirst !== false) itemsOf(node)[0]?.focus();

	async function openSubmenu(trigger: HTMLElement) {
		if (trigger.getAttribute('aria-expanded') !== 'true') {
			trigger.click();
			await tick();
		}
		const sub = submenuOf(trigger);
		if (sub) itemsOf(sub)[0]?.focus();
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Tab') {
			current.refocus?.();
			current.close();
			return;
		}
		const active = document.activeElement as HTMLElement | null;
		const level = active?.closest<HTMLElement>('[role="menu"]');
		const within = level && node.contains(level) ? level : node;
		const items = itemsOf(within);
		const at = items.indexOf(active as HTMLElement);

		if (event.key === 'ArrowRight' && at >= 0 && active?.getAttribute('aria-haspopup') === 'menu') {
			event.preventDefault();
			void openSubmenu(active);
			return;
		}
		if (event.key === 'ArrowLeft' && within !== node) {
			const trigger = within.parentElement?.querySelector<HTMLElement>(
				':scope > [aria-haspopup="menu"]'
			);
			if (!trigger) return;
			event.preventDefault();
			trigger.focus();
			if (trigger.getAttribute('aria-expanded') === 'true') trigger.click();
			return;
		}
		if (
			event.key !== 'ArrowDown' &&
			event.key !== 'ArrowUp' &&
			event.key !== 'Home' &&
			event.key !== 'End'
		)
			return;
		event.preventDefault();
		const next = nextIndex(at, items.length, event.key);
		if (next !== null) items[next].focus();
	}

	node.addEventListener('keydown', onKeydown);
	return {
		update(next: MenuParams) {
			current = next;
		},
		destroy() {
			node.removeEventListener('keydown', onKeydown);
		}
	};
};
