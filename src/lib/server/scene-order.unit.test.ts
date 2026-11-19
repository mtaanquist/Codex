import { describe, it, expect } from 'vitest';
import { movedScenes } from './scene-order.ts';

describe('movedScenes', () => {
	it('names nothing when the order is the same', () => {
		expect(movedScenes(['a', 'b', 'c'], ['a', 'b', 'c'])).toEqual([]);
	});

	it('names only the scene moved from the start to the end', () => {
		expect(movedScenes(['a', 'b', 'c', 'd'], ['b', 'c', 'd', 'a'])).toEqual(['a']);
	});

	it('names only the scene moved from the end to the start', () => {
		expect(movedScenes(['a', 'b', 'c', 'd'], ['d', 'a', 'b', 'c'])).toEqual(['d']);
	});

	it('names one of two swapped scenes', () => {
		expect(movedScenes(['a', 'b', 'c'], ['a', 'c', 'b'])).toHaveLength(1);
	});

	it('leaves the rest in their old relative order', () => {
		const was = ['a', 'b', 'c', 'd', 'e', 'f'];
		const now = ['c', 'a', 'f', 'b', 'e', 'd'];
		const moved = new Set(movedScenes(was, now));
		const kept = now.filter((id) => !moved.has(id));
		expect(kept).toEqual(was.filter((id) => kept.includes(id)));
		// a, b, e (or a, b, d) is the longest run that kept its order.
		expect(kept).toHaveLength(3);
	});

	it('counts a scene the old order did not have as moved', () => {
		expect(movedScenes(['a', 'b'], ['a', 'x', 'b'])).toEqual(['x']);
	});
});
