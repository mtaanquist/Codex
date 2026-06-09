import { describe, it, expect } from 'vitest';
import { loreMatches } from './sources';

describe('loreMatches', () => {
	it('matches a keyword as a case-insensitive substring of the scope text', () => {
		expect(loreMatches(['Aether'], 'The aether crackled overhead.')).toBe(true);
	});

	it('does not match when no keyword appears', () => {
		expect(loreMatches(['Aether', 'Voidstone'], 'A quiet morning in the village.')).toBe(false);
	});

	it('ignores blank and whitespace-only keywords', () => {
		expect(loreMatches(['', '   '], 'anything at all')).toBe(false);
	});

	it('trims surrounding whitespace on a keyword before matching', () => {
		expect(loreMatches(['  guild  '], 'a member of the guild')).toBe(true);
	});

	it('returns false for an empty keyword list', () => {
		expect(loreMatches([], 'some text')).toBe(false);
	});
});
