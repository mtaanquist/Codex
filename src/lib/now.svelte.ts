import { createSubscriber } from 'svelte/reactivity';

// The current time for relative times ("5m"). Read in a template, it re-renders
// that text every half minute while anything shows it, and once just after the
// page hydrates: the server rendered the text at a slightly different moment,
// and hydration keeps the server's text until the next re-render. On the
// server it is simply the clock.

const TICK_MS = 30_000;

const subscribe = createSubscriber((update) => {
	const first = setTimeout(update, 0);
	const timer = setInterval(update, TICK_MS);
	return () => {
		clearTimeout(first);
		clearInterval(timer);
	};
});

export function now(): number {
	subscribe();
	return Date.now();
}
