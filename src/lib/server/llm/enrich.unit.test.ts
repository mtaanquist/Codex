import { describe, it, expect } from 'vitest';
import { parseEnrichResponse, spreadAppearances } from './enrich';

describe('parseEnrichResponse', () => {
	it('parses aliases, details, and a summary from clean JSON', () => {
		const text = JSON.stringify({
			aliases: ['The Grey', '  Bram-o  '],
			details: [{ label: 'Eyes', value: 'grey' }],
			summary: 'A weary swordsman.'
		});
		const out = parseEnrichResponse(text);
		expect(out).toContainEqual({ field: 'alias', value: 'The Grey' });
		expect(out).toContainEqual({ field: 'alias', value: 'Bram-o' });
		expect(out).toContainEqual({ field: 'detail', label: 'Eyes', value: 'grey' });
		expect(out).toContainEqual({ field: 'summary', value: 'A weary swordsman.' });
	});

	it('pulls the JSON object out of surrounding prose', () => {
		const text =
			'Sure! Here is the result:\n{"aliases":["Al"],"details":[],"summary":null}\nHope that helps.';
		const out = parseEnrichResponse(text);
		expect(out).toEqual([{ field: 'alias', value: 'Al' }]);
	});

	it('returns nothing for malformed or empty output, never throwing', () => {
		expect(parseEnrichResponse('not json at all')).toEqual([]);
		expect(parseEnrichResponse('{ broken')).toEqual([]);
		expect(parseEnrichResponse('')).toEqual([]);
	});

	it('ignores malformed entries but keeps the valid ones', () => {
		const text = JSON.stringify({
			aliases: ['Good', '', 42],
			details: [{ label: 'Role' }, { label: 'Rank', value: 'captain' }],
			summary: 12
		});
		const out = parseEnrichResponse(text);
		expect(out).toEqual([
			{ field: 'alias', value: 'Good' },
			{ field: 'detail', label: 'Rank', value: 'captain' }
		]);
	});
});

describe('spreadAppearances', () => {
	const row = (storyId: string, n: number) => ({ storyId, n });

	it('takes appearances from each story in turn, kept in reading order', () => {
		const rows = [row('a', 1), row('a', 2), row('a', 3), row('b', 1), row('c', 1), row('c', 2)];
		expect(spreadAppearances(rows, 4)).toEqual([
			row('a', 1),
			row('a', 2),
			row('b', 1),
			row('c', 1)
		]);
	});

	it('returns everything, in order, when under the limit', () => {
		const rows = [row('a', 1), row('a', 2)];
		expect(spreadAppearances(rows, 16)).toEqual(rows);
		expect(spreadAppearances([], 16)).toEqual([]);
	});
});
