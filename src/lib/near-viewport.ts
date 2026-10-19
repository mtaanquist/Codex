import type { Attachment } from 'svelte/attachments';

// How far outside the visible area an element counts as near: a few screens,
// so content is ready before the reader scrolls to it.
const MARGIN = '2000px 0px';

type Watch = { observer: IntersectionObserver; callbacks: Map<Element, () => void> };

// One observer per scroll container, shared by every element watched in it.
const watches = new WeakMap<Element, Watch>();

function watchFor(root: Element): Watch {
	let watch = watches.get(root);
	if (!watch) {
		const callbacks = new Map<Element, () => void>();
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (!entry.isIntersecting) continue;
					const callback = callbacks.get(entry.target);
					callbacks.delete(entry.target);
					observer.unobserve(entry.target);
					callback?.();
				}
			},
			{ root, rootMargin: MARGIN }
		);
		watch = { observer, callbacks };
		watches.set(root, watch);
	}
	return watch;
}

// Calls onNear once, when the element comes within a few screens of the
// visible part of root (the scroll container it sits in). Without
// IntersectionObserver it calls onNear straight away.
export function nearViewport(root: Element, onNear: () => void): Attachment<Element> {
	return (node) => {
		if (typeof IntersectionObserver === 'undefined') {
			onNear();
			return;
		}
		const watch = watchFor(root);
		watch.callbacks.set(node, onNear);
		watch.observer.observe(node);
		return () => {
			watch.callbacks.delete(node);
			watch.observer.unobserve(node);
		};
	};
}
