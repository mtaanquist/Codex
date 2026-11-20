import { describe, it, expect } from 'vitest';
import {
	formatExcerpts,
	partBudgetTokens,
	splitExcerptParts,
	UNKNOWN_WINDOW_PART_TOKENS,
	withNeighbours,
	type ExcerptScene
} from './enrich-context';
import { mergeProposals } from './enrich';
import { buildEnrichTextMessage } from './prompts/enrich';

const scene = (id: string, over: Partial<ExcerptScene> = {}): ExcerptScene => ({
	id,
	storyId: 's1',
	storyTitle: 'The Tide Below',
	chapterTitle: 'One',
	title: `Scene ${id}`,
	bodyMd: `Body of ${id}.`,
	...over
});

describe('withNeighbours', () => {
	const order = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, storyId: 's1' }));

	it('adds the scene before and after each mentioned scene', () => {
		expect([...withNeighbours(order, new Set(['c']))].sort()).toEqual(['b', 'c', 'd']);
	});

	it('has no neighbour past either end, and counts a shared neighbour once', () => {
		expect([...withNeighbours(order, new Set(['a', 'c']))].sort()).toEqual(['a', 'b', 'c', 'd']);
		expect([...withNeighbours(order, new Set(['e']))].sort()).toEqual(['d', 'e']);
	});

	it('does not take a neighbour from another story', () => {
		const two = [
			{ id: 'a', storyId: 's1' },
			{ id: 'b', storyId: 's1' },
			{ id: 'x', storyId: 's2' },
			{ id: 'y', storyId: 's2' }
		];
		expect([...withNeighbours(two, new Set(['b']))].sort()).toEqual(['a', 'b']);
		expect([...withNeighbours(two, new Set(['x']))].sort()).toEqual(['x', 'y']);
	});

	it('picks nothing when nothing is mentioned', () => {
		expect(withNeighbours(order, new Set()).size).toBe(0);
	});
});

describe('formatExcerpts', () => {
	it('puts a chapter heading where the chapter changes', () => {
		const text = formatExcerpts(
			[scene('a'), scene('b'), scene('c', { chapterTitle: 'Two' })],
			false
		);
		expect(text.match(/^## /gm)).toHaveLength(2);
		expect(text.indexOf('## One')).toBeLessThan(text.indexOf('### Scene a'));
		expect(text.indexOf('### Scene b')).toBeLessThan(text.indexOf('## Two'));
		expect(text).not.toContain('# The Tide Below');
	});

	it('names each story when more than one is read, and repeats a chapter title per story', () => {
		const text = formatExcerpts(
			[scene('a'), scene('x', { storyId: 's2', storyTitle: 'The Salt Road' })],
			true
		);
		expect(text).toContain('# The Tide Below');
		expect(text).toContain('# The Salt Road');
		expect(text.match(/^## One$/gm)).toHaveLength(2);
	});

	it('marks an empty scene and an untitled one', () => {
		const text = formatExcerpts([scene('a', { title: null, bodyMd: '  ' })], false);
		expect(text).toContain('### Untitled scene\n(empty)');
	});
});

describe('splitExcerptParts', () => {
	it('keeps everything in one part when it fits', () => {
		expect(splitExcerptParts([scene('a'), scene('b')], 1000)).toHaveLength(1);
	});

	it('starts a new part when the next scene would pass the budget, keeping the order', () => {
		const long = 'word '.repeat(300);
		const parts = splitExcerptParts(
			['a', 'b', 'c'].map((id) => scene(id, { bodyMd: long })),
			800
		);
		expect(parts.map((part) => part.map((s) => s.id))).toEqual([['a', 'b'], ['c']]);
	});

	it('cuts a scene longer than the budget at paragraph breaks, losing no text', () => {
		const paragraphs = Array.from({ length: 10 }, (_, i) => `Paragraph ${i} ${'x'.repeat(380)}`);
		const parts = splitExcerptParts([scene('a', { bodyMd: paragraphs.join('\n\n') })], 300);
		expect(parts.length).toBeGreaterThan(1);
		const pieces = parts.flat();
		expect(pieces.every((piece) => piece.id === 'a')).toBe(true);
		expect(pieces.every((piece) => piece.bodyMd.length <= 1200)).toBe(true);
		expect(pieces.map((piece) => piece.bodyMd).join('\n\n')).toBe(paragraphs.join('\n\n'));
	});

	it('cuts a single paragraph longer than the budget', () => {
		const parts = splitExcerptParts([scene('a', { bodyMd: 'y'.repeat(5000) })], 250);
		expect(
			parts
				.flat()
				.map((piece) => piece.bodyMd)
				.join('')
		).toBe('y'.repeat(5000));
		expect(parts.flat().every((piece) => piece.bodyMd.length <= 1000)).toBe(true);
	});
});

describe('partBudgetTokens', () => {
	it('falls back to a modest budget when the window is unknown', () => {
		expect(partBudgetTokens(undefined, 1500)).toBe(UNKNOWN_WINDOW_PART_TOKENS);
	});

	it('leaves room for the reply inside four fifths of the window', () => {
		const budget = partBudgetTokens(100_000, 2000);
		expect(budget).toBeLessThan(80_000 - 2000);
		expect(budget).toBeGreaterThan(70_000);
	});

	it('never goes below the floor on a tiny window', () => {
		expect(partBudgetTokens(2000, 1500)).toBe(1000);
	});
});

describe('mergeProposals', () => {
	it('keeps the first alias, detail label and summary found, whatever the case, with the summary last', () => {
		const merged = mergeProposals(
			[
				{ field: 'alias', value: 'The Grey' },
				{ field: 'detail', label: 'Eyes', value: 'grey' },
				{ field: 'summary', value: 'First.' }
			],
			[
				{ field: 'alias', value: 'the grey' },
				{ field: 'alias', value: 'Old Bram' },
				{ field: 'detail', label: 'eyes', value: 'blue' },
				{ field: 'detail', label: 'Role', value: 'harbourmaster' },
				{ field: 'summary', value: 'Second.' }
			]
		);
		expect(merged).toEqual([
			{ field: 'alias', value: 'The Grey' },
			{ field: 'detail', label: 'Eyes', value: 'grey' },
			{ field: 'alias', value: 'Old Bram' },
			{ field: 'detail', label: 'Role', value: 'harbourmaster' },
			{ field: 'summary', value: 'First.' }
		]);
	});

	it('does not confuse an alias with a detail label of the same text', () => {
		const merged = mergeProposals(
			[{ field: 'alias', value: 'Captain' }],
			[{ field: 'detail', label: 'Captain', value: 'of the Gull' }]
		);
		expect(merged).toHaveLength(2);
	});
});

describe('buildEnrichTextMessage', () => {
	const entity = {
		kind: 'character' as const,
		name: 'Bram',
		aliases: ['Al'],
		details: [{ label: 'Eyes', value: 'grey' }],
		summaryMd: null,
		hasSummary: false
	};

	it('puts the text before the entity and the instructions', () => {
		const message = buildEnrichTextMessage(entity, 'THE STORY TEXT');
		expect(message.indexOf('THE STORY TEXT')).toBeLessThan(message.indexOf('Enrich the character'));
		expect(message).toContain('Known aliases: Al.');
		expect(message).toContain('Known detail - Eyes: grey');
		expect(message).not.toContain('part 1 of');
	});

	it('lists what earlier parts found as already known, and numbers the part', () => {
		const message = buildEnrichTextMessage(entity, 'text', {
			part: { index: 2, total: 3 },
			found: { aliases: ['The Grey'], details: [{ label: 'Role', value: 'harbourmaster' }] }
		});
		expect(message).toContain('part 2 of 3');
		expect(message).toContain('Known aliases: Al, The Grey.');
		expect(message).toContain('Known detail - Role: harbourmaster');
	});

	it('asks for keywords on a lore entry and no summary when one is closed', () => {
		const message = buildEnrichTextMessage({ ...entity, kind: 'lore', hasSummary: true }, 'text');
		expect(message).toContain('Known keywords: Al.');
		expect(message).toContain('do not propose a summary');
		expect(message).toContain('"summary": null');
	});
});
