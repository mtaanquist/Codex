import { createSubscriber } from 'svelte/reactivity';

// The current time for relative times ("5m"). Read in a template, it re-renders
// that text every half minute while anything shows it, so a page left open does
// not keep saying "just now". On the server it is simply the clock.

const TICK_MS = 30_000;

const subscribe = createSubscriber((update) => {
	const timer = setInterval(update, TICK_MS);
	return () => clearInterval(timer);
});

export function now(): number {
	subscribe();
	return Date.now();
}
