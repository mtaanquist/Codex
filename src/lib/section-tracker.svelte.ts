import { sectionInView } from './section-in-view';

// Just below the 52px top bar, with room for a heading's top margin.
const LINE = 84;

// Follows which of a page's sections is in view as the reader scrolls (the
// window or any pane). Call during component setup.
export function trackSectionInView(ids: () => readonly string[] | undefined) {
	const current = $state<{ id: string | null }>({ id: null });
	$effect(() => {
		const list = ids() ?? [];
		const update = () => {
			const tops = list.flatMap((id) => {
				const el = document.getElementById(id);
				return el ? [{ id, top: el.getBoundingClientRect().top }] : [];
			});
			current.id = sectionInView(tops, LINE);
		};
		update();
		document.addEventListener('scroll', update, { capture: true, passive: true });
		return () => document.removeEventListener('scroll', update, { capture: true });
	});
	return current;
}
