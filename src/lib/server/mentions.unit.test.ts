import { describe, it, expect } from 'vitest';
import { changedTargets } from './mentions.ts';

const row = (targetId: string, surroundingText: string, position = 0) => ({
	targetType: 'character' as const,
	targetId,
	position,
	surroundingText
});

describe('changedTargets', () => {
	it('ignores an entity whose passages are the same and in the same order', () => {
		// Row order is not reading order; positions may shift with text added above.
		const before = [row('a', 'Bram at the harbour', 0), row('a', 'Bram again', 40)];
		const after = [row('a', 'Bram again', 90), row('a', 'Bram at the harbour', 50)];
		expect(changedTargets(before, after)).toEqual([]);
	});

	it('names an entity whose passages swapped places', () => {
		const before = [row('a', 'Bram at the harbour', 0), row('a', 'Bram again', 40)];
		const after = [row('a', 'Bram again', 0), row('a', 'Bram at the harbour', 30)];
		expect(changedTargets(before, after).map((t) => t.targetId)).toEqual(['a']);
	});

	it('names an entity newly mentioned, no longer mentioned, or quoted differently', () => {
		const before = [row('a', 'Bram at the harbour'), row('b', 'Cass waits'), row('c', 'Dov')];
		const after = [row('a', 'Bram on the quay'), row('c', 'Dov'), row('d', 'The Grey')];
		expect(changedTargets(before, after).map((t) => t.targetId)).toEqual(['a', 'b', 'd']);
	});

	it('counts a passage that appears one more time', () => {
		const before = [row('a', 'Bram')];
		const after = [row('a', 'Bram'), row('a', 'Bram')];
		expect(changedTargets(before, after).map((t) => t.targetId)).toEqual(['a']);
	});
});
