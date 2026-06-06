import { describe, it, expect } from 'vitest';
import { replaceWholeWord, wholeWordMatches } from './prose-replace';

describe('wholeWordMatches', () => {
	it('matches whole words only, case-sensitively', () => {
		expect(wholeWordMatches('Alice met alice in Alicester.', 'Alice')).toEqual([0]);
	});

	it('matches through possessives and punctuation', () => {
		expect(wholeWordMatches("Alice's coat. (Alice!) Alice,", 'Alice')).toEqual([0, 15, 23]);
	});

	it('matches multi-word names with regex metacharacters', () => {
		expect(wholeWordMatches('She saw Mrs. Fenwick wave.', 'Mrs. Fenwick')).toEqual([8]);
	});

	it('returns nothing for an empty needle', () => {
		expect(wholeWordMatches('anything', '')).toEqual([]);
	});
});

describe('replaceWholeWord', () => {
	it('replaces every occurrence and reports the count', () => {
		const result = replaceWholeWord('Alice saw Alice.', 'Alice', 'Alicia');
		expect(result.body).toBe('Alicia saw Alicia.');
		expect(result.count).toBe(2);
	});

	it('leaves partial words alone', () => {
		const result = replaceWholeWord('Alicester is not Alice.', 'Alice', 'Mara');
		expect(result.body).toBe('Alicester is not Mara.');
	});

	it('returns the body untouched when nothing matches', () => {
		const result = replaceWholeWord('No one here.', 'Alice', 'Mara');
		expect(result.body).toBe('No one here.');
		expect(result.count).toBe(0);
	});

	it('shifts anchors after a match by the length difference', () => {
		// "Alice walked." -> "Mo walked." : anchors on "walked" (6..12) move
		// back by 3.
		const result = replaceWholeWord('Alice walked.', 'Alice', 'Mo', [
			{ anchorStart: 6, anchorEnd: 12 }
		]);
		expect(result.body).toBe('Mo walked.');
		expect(result.anchors[0]).toEqual({ anchorStart: 3, anchorEnd: 9 });
	});

	it('keeps anchors before a match in place and accumulates shifts after several', () => {
		const body = 'Hi. Alice met Alice today.';
		const result = replaceWholeWord(body, 'Alice', 'Jo', [
			{ anchorStart: 0, anchorEnd: 3 },
			{ anchorStart: body.indexOf('today'), anchorEnd: body.indexOf('today') + 5 }
		]);
		expect(result.body).toBe('Hi. Jo met Jo today.');
		expect(result.anchors[0]).toEqual({ anchorStart: 0, anchorEnd: 3 });
		expect(result.anchors[1]).toEqual({
			anchorStart: result.body.indexOf('today'),
			anchorEnd: result.body.indexOf('today') + 5
		});
	});

	it('clamps an anchor inside a match into the replacement', () => {
		// Anchor over "lic" inside "Alice" (1..4); the replacement "Jo" is
		// shorter, so it clamps within it.
		const result = replaceWholeWord('Alice.', 'Alice', 'Jo', [{ anchorStart: 1, anchorEnd: 4 }]);
		expect(result.body).toBe('Jo.');
		expect(result.anchors[0].anchorStart).toBe(1);
		expect(result.anchors[0].anchorEnd).toBe(2);
		expect(result.anchors[0].anchorEnd).toBeLessThanOrEqual(result.body.length);
	});

	it('keeps extra anchor fields intact', () => {
		const result = replaceWholeWord('Alice.', 'Alice', 'Mara', [
			{ id: 'm1', anchorStart: 0, anchorEnd: 5 }
		]);
		expect(result.anchors[0]).toEqual({ id: 'm1', anchorStart: 0, anchorEnd: 4 });
	});
});
