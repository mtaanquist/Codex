import { sectionInView } from './section-in-view';

// Room below a jumped-to heading's landing spot for its top margin.
const SLACK = 16;

function scrollerOf(el: HTMLElement): HTMLElement | null {
	for (let node = el.parentElement; node; node = node.parentElement) {
		const { overflowY } = getComputedStyle(node);
		if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight)
			return node;
	}
	return null;
}

// Follows which of a page's sections is in view as the reader scrolls (the
// window or any pane). Call during component setup.
export function trackSectionInView(ids: () => readonly string[] | undefined) {
	const current = $state<{ id: string | null }>({ id: null });
	$effect(() => {
		const list = ids() ?? [];
		const update = () => {
			const els = list.flatMap((id) => {
				const el = document.getElementById(id);
				return el ? [el] : [];
			});
			if (els.length === 0) {
				current.id = null;
				return;
			}
			// A jump lands a heading at its scroller's top plus its scroll
			// margin, so the line sits there too.
			const scroller = scrollerOf(els[0]);
			const box = scroller?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
			const margin = parseFloat(getComputedStyle(els[0]).scrollMarginTop) || 0;
			const scrolled = scroller ?? document.scrollingElement ?? document.documentElement;
			const atBottom =
				scrolled.scrollHeight > scrolled.clientHeight &&
				scrolled.scrollTop + scrolled.clientHeight >= scrolled.scrollHeight - 2;
			const tops = els.map((el) => ({ id: el.id, top: el.getBoundingClientRect().top }));
			current.id = sectionInView(
				tops,
				box.top + margin + SLACK,
				atBottom
					? { viewBottom: box.bottom, target: decodeURIComponent(location.hash.slice(1)) || null }
					: undefined
			);
		};
		update();
		document.addEventListener('scroll', update, { capture: true, passive: true });
		window.addEventListener('hashchange', update);
		return () => {
			document.removeEventListener('scroll', update, { capture: true });
			window.removeEventListener('hashchange', update);
		};
	});
	return current;
}
