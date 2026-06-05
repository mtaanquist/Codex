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

describe('shared names', () => {
	const will: MentionTarget = { id: 'c1', type: 'character', names: ['Will'] };
	const willPlace: MentionTarget = { id: 'p1', type: 'place', names: ['Will'] };
	const willLore: MentionTarget = { id: 'l1', type: 'lore_entry', names: ['Willow', 'Will'] };

	it('attributes deterministically: characters before places before lore', () => {
		const found = detectMentions('Will waits.', [willLore, willPlace, will]);
		expect(found).toHaveLength(1);
		expect(found[0].targetId).toBe('c1');
		// The full candidate set rides along, winner first.
		expect(found[0].candidates?.map((candidate) => candidate.id)).toEqual(['c1', 'p1', 'l1']);
	});

	it('entities declared in the story outrank the rest', () => {
		const found = detectMentions('Will waits.', [will, willPlace], {
			storyMembers: new Set(['p1'])
		});
		expect(found[0].targetId).toBe('p1');
	});

	it('a primary name beats an alias at the same rank', () => {
		const aliased: MentionTarget = { id: 'c2', type: 'character', names: ['Wren', 'Will'] };
		const found = detectMentions('Will waits.', [aliased, will]);
		expect(found[0].targetId).toBe('c1');
	});

	it('a pin overrides everything', () => {
		const found = detectMentions('Will waits.', [will, willPlace, willLore], {
			storyMembers: new Set(['c1']),
			pins: new Map([['Will', 'l1']])
		});
		expect(found[0].targetId).toBe('l1');
	});

	it('an unambiguous match carries no candidate set', () => {
		const found = detectMentions('Will waits.', [will]);
		expect(found[0].candidates).toBeUndefined();
	});

	it('the same string as name and alias of one entity is not ambiguous', () => {
		const doubled: MentionTarget = { id: 'c3', type: 'character', names: ['Ash', 'Ash'] };
		const found = detectMentions('Ash falls.', [doubled]);
		expect(found[0].candidates).toBeUndefined();
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
