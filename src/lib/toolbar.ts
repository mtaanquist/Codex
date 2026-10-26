import type { Action } from 'svelte/action';
import { nextIndex, type MenuKey } from './menu';

const KEYS: Record<string, MenuKey> = {
	ArrowRight: 'ArrowDown',
	ArrowLeft: 'ArrowUp',
	Home: 'Home',
	End: 'End'
};

// The bar's own controls: not a hidden measuring copy, and not the items of
// a menu that opened from it.
function toolsOf(bar: HTMLElement): HTMLElement[] {
	return [...bar.querySelectorAll<HTMLElement>('button, a[href]')].filter(
		(el) =>
			!el.closest('[aria-hidden="true"], [role="menu"]') && !(el as HTMLButtonElement).disabled
	);
}

// Keyboard behaviour for a role="toolbar": the bar is one tab stop, the arrow
// keys move between its controls and wrap, and Home and End jump to the ends.
// Tab returns to the control last used. Controls come and go as the bar
// resizes, so the tab stop is reassigned whenever its children change.
export const toolbar: Action<HTMLElement> = (node) => {
	let current: HTMLElement | null = null;
	let index = 0;

	function sync() {
		const tools = toolsOf(node);
		const at = current ? tools.indexOf(current) : -1;
		index = at >= 0 ? at : Math.max(0, Math.min(index, tools.length - 1));
		current = tools[index] ?? null;
		tools.forEach((el, i) => (el.tabIndex = i === index ? 0 : -1));
	}

	function onFocusin(event: FocusEvent) {
		const tools = toolsOf(node);
		if (tools.includes(event.target as HTMLElement)) {
			current = event.target as HTMLElement;
			sync();
		}
	}

	function onKeydown(event: KeyboardEvent) {
		const key = KEYS[event.key];
		if (!key) return;
		const tools = toolsOf(node);
		const at = tools.indexOf(event.target as HTMLElement);
		if (at < 0) return;
		const next = nextIndex(at, tools.length, key);
		if (next === null) return;
		event.preventDefault();
		current = tools[next];
		sync();
		current.focus();
	}

	const observer = new MutationObserver(sync);
	observer.observe(node, { childList: true, subtree: true });
	node.addEventListener('focusin', onFocusin);
	node.addEventListener('keydown', onKeydown);
	sync();

	return {
		destroy() {
			observer.disconnect();
			node.removeEventListener('focusin', onFocusin);
			node.removeEventListener('keydown', onKeydown);
		}
	};
};
