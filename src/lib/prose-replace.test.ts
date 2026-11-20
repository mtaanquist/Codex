import { describe, it, expect } from 'vitest';
import {
	findMatches,
	matchContext,
	replaceMatches,
	replaceWholeWord,
	wholeWordMatches
} from './prose-replace';

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

describe('findMatches', () => {
	const body = 'The city slept. City lights. Velocity. The CITY woke.';

	it('honours match case and whole word together', () => {
		expect(findMatches(body, 'city', { matchCase: true, wholeWord: true })).toEqual([
			{ start: 4, end: 8 }
		]);
	});

	it('ignores case when asked', () => {
		const starts = findMatches(body, 'city', { matchCase: false, wholeWord: true }).map(
			(m) => m.start
		);
		expect(starts).toEqual([4, 16, 43]);
	});

	it('matches inside words when whole word is off', () => {
		const starts = findMatches(body, 'city', { matchCase: true, wholeWord: false }).map(
			(m) => m.start
		);
		expect(starts).toEqual([4, body.indexOf('Velocity') + 4]);
	});

	it('treats the needle literally', () => {
		expect(findMatches('a.b axb', 'a.b', { matchCase: true, wholeWord: false })).toEqual([
			{ start: 0, end: 3 }
		]);
	});

	it('returns nothing for an empty needle', () => {
		expect(findMatches('anything', '', { matchCase: false, wholeWord: false })).toEqual([]);
	});
});

describe('replaceMatches', () => {
	it('replaces only the matches it is given', () => {
		const body = 'city, city, city';
		const matches = findMatches(body, 'city', { matchCase: true, wholeWord: true });
		const result = replaceMatches(body, [matches[0], matches[2]], 'village');
		expect(result.body).toBe('village, city, village');
	});

	it('replaces with nothing', () => {
		const body = 'a very very long day';
		const matches = findMatches(body, 'very ', { matchCase: true, wholeWord: false });
		expect(replaceMatches(body, matches, '').body).toBe('a long day');
	});

	it('carries anchors past skipped and replaced matches', () => {
		const body = 'city one city two city';
		const matches = findMatches(body, 'city', { matchCase: true, wholeWord: true });
		const two = body.indexOf('two');
		const result = replaceMatches(body, [matches[0], matches[2]], 'town!', [
			{ anchorStart: two, anchorEnd: two + 3 },
			// Inside the last match: clamps into the replacement.
			{ anchorStart: matches[2].start + 1, anchorEnd: matches[2].end }
		]);
		expect(result.body).toBe('town! one city two town!');
		expect(result.body.slice(result.anchors[0].anchorStart, result.anchors[0].anchorEnd)).toBe(
			'two'
		);
		expect(result.anchors[1]).toEqual({
			anchorStart: result.body.length - 4,
			anchorEnd: result.body.length
		});
	});
});

describe('matchContext', () => {
	it('shows the passage around a match, cut at word edges', () => {
		const body = 'Far away there was a quiet city by the sea, and nobody ever left it at all.';
		const [match] = findMatches(body, 'city', { matchCase: true, wholeWord: true });
		const context = matchContext(body, match, 12);
		expect(context.text).toBe('city');
		expect(context.before).toBe('...a quiet ');
		expect(context.after).toBe(' by the sea,...');
	});

	it('stops at line breaks', () => {
		const body = 'First line.\nThe city.\nLast line.';
		const [match] = findMatches(body, 'city', { matchCase: true, wholeWord: true });
		expect(matchContext(body, match)).toEqual({ before: 'The ', text: 'city', after: '.' });
	});
});
