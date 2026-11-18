import { describe, it, expect } from 'vitest';
import { sampleEvenly } from './arc-summary';
import { buildArcMessage } from './prompts/arc';

describe('sampleEvenly', () => {
	it('keeps everything under the limit', () => {
		expect(sampleEvenly([1, 2, 3], 5)).toEqual([1, 2, 3]);
	});

	it('keeps the first and last and spreads the rest', () => {
		const items = Array.from({ length: 10 }, (_, i) => i);
		const picked = sampleEvenly(items, 4);
		expect(picked).toHaveLength(4);
		expect(picked[0]).toBe(0);
		expect(picked[3]).toBe(9);
		expect([...picked].sort((a, b) => a - b)).toEqual(picked);
	});
});

describe('buildArcMessage', () => {
	it('names the character and labels each scene with its story', () => {
		const text = buildArcMessage('Bram', [
			{ storyTitle: 'The Tide Below', sceneTitle: 'Quay', text: 'Bram leaves home.' },
			{ storyTitle: 'The Salt Road', sceneTitle: null, text: 'Bram takes the helm.' }
		]);
		expect(text).toContain('"Bram"');
		expect(text).toContain('1. [The Tide Below / Quay] Bram leaves home.');
		expect(text).toContain('2. [The Salt Road] Bram takes the helm.');
	});
});
