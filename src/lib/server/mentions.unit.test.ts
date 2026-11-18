import { describe, it, expect } from 'vitest';
import { changedTargets } from './mentions.ts';

const row = (targetId: string, surroundingText: string) => ({
	targetType: 'character' as const,
	targetId,
	surroundingText
});

describe('changedTargets', () => {
	it('ignores an entity whose passages are the same, in any order', () => {
		const before = [row('a', 'Bram at the harbour'), row('a', 'Bram again')];
		const after = [row('a', 'Bram again'), row('a', 'Bram at the harbour')];
		expect(changedTargets(before, after)).toEqual([]);
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
