import { describe, it, expect } from 'vitest';
import { wordCount } from './word-count';

describe('wordCount', () => {
	it('counts whitespace-delimited words', () => {
		expect(wordCount('the quick brown fox')).toBe(4);
	});

	it('treats runs of whitespace as a single separator', () => {
		expect(wordCount('  spaced   out \n words ')).toBe(3);
	});

	it('returns 0 for empty or blank input', () => {
		expect(wordCount('')).toBe(0);
		expect(wordCount('   ')).toBe(0);
	});
});
