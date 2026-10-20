import { describe, it, expect } from 'vitest';
import { textHash } from './text-hash';

describe('textHash', () => {
	it('is stable for the same text and differs for a one-character change', () => {
		expect(textHash('The gate opened.')).toBe(textHash('The gate opened.'));
		expect(textHash('The gate opened.')).not.toBe(textHash('The gate opened!'));
	});

	it('handles empty and non-ASCII text', () => {
		expect(textHash('')).toMatch(/^[0-9a-f]+$/);
		expect(textHash('\u00c6blegr\u00f8d')).not.toBe(textHash('Aeblegrod'));
	});
});
