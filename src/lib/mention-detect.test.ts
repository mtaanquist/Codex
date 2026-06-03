import { describe, it, expect } from 'vitest';
import { detectMentions, mentionSnippet, type MentionTarget } from './mention-detect';

const alice: MentionTarget = {
	id: 'a',
	type: 'character',
	names: ['Alice Vane', 'Alice', 'Mrs. Fenwick']
};
const bram: MentionTarget = { id: 'b', type: 'character', names: ['Bram'] };

describe('detectMentions', () => {
	it('finds names and aliases with positions', () => {
		const body = 'Alice counted the coin. Bram grinned.';
		const found = detectMentions(body, [alice, bram]);
		expect(found).toEqual([
			{ targetType: 'character', targetId: 'a', position: 0, length: 5, text: 'Alice' },
			{ targetType: 'character', targetId: 'b', position: 24, length: 4, text: 'Bram' }
		]);
	});

	it('prefers the longest overlapping name', () => {
		const found = detectMentions('Alice Vane paid the toll.', [alice]);
		expect(found).toHaveLength(1);
		expect(found[0].text).toBe('Alice Vane');
	});

	it('respects word boundaries', () => {
		expect(detectMentions('Bramble hedges and abram.', [bram])).toEqual([]);
	});

	it('matches aliases containing punctuation', () => {
		const found = detectMentions('"Mrs. Fenwick," the toll-keeper said.', [alice]);
		expect(found).toHaveLength(1);
		expect(found[0].text).toBe('Mrs. Fenwick');
	});

	it('is case-sensitive', () => {
		expect(detectMentions('a bram of light', [bram])).toEqual([]);
	});

	it('ignores single-character names and blank aliases', () => {
		const odd: MentionTarget = { id: 'o', type: 'character', names: ['Q', ' ', 'Quill'] };
		const found = detectMentions('Q sent Quill.', [odd]);
		expect(found).toHaveLength(1);
		expect(found[0].text).toBe('Quill');
	});
});

describe('mentionSnippet', () => {
	it('clips around the match with ellipses only where text is cut', () => {
		const body = 'x'.repeat(100) + 'Alice' + 'y'.repeat(100);
		const snippet = mentionSnippet(body, 100, 5, 10);
		expect(snippet).toBe('...' + 'x'.repeat(10) + 'Alice' + 'y'.repeat(10) + '...');
		expect(mentionSnippet('Alice waits.', 0, 5)).toBe('Alice waits.');
	});
});
