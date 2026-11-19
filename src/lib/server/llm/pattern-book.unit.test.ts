import { describe, expect, it } from 'vitest';
import {
	bookPatternUnit,
	patternSurveyTokens,
	WHOLE_BOOK_SHARE,
	wholeBookFit
} from './pattern-pass';

describe('wholeBookFit', () => {
	it('fits at or under the share of the window, and goes by chapter over it', () => {
		const window = 100_000;
		const edge = window * WHOLE_BOOK_SHARE;
		expect(wholeBookFit(edge, window)).toBe('fits');
		expect(wholeBookFit(edge - 1, window)).toBe('fits');
		expect(wholeBookFit(edge + 1, window)).toBe('chapters');
	});

	it('is not offered when the window is unknown', () => {
		expect(wholeBookFit(10, undefined)).toBe('unavailable');
	});
});

describe('bookPatternUnit', () => {
	const scenes = [
		{ id: 'a', title: 'A', bodyMd: 'a', chapterId: 'c1' },
		{ id: 'b', title: 'B', bodyMd: 'b', chapterId: 'c1' },
		{ id: 'c', title: 'C', bodyMd: 'c', chapterId: null },
		{ id: 'd', title: 'D', bodyMd: 'd', chapterId: 'c2' }
	];
	const titles = new Map<string, string | null>([
		['c1', 'The Road'],
		['c2', null]
	]);

	it('lists every scene under its chapter title, as one request when it fits', () => {
		const unit = bookPatternUnit(scenes, titles, true);
		expect(unit).toMatchObject({ key: 'book', scope: 'book', whole: true });
		expect(unit.chapters).toBeUndefined();
		expect(unit.scenes.map((s) => s.chapterTitle)).toEqual([
			'The Road',
			'The Road',
			'Unfiled scenes',
			'Untitled chapter'
		]);
	});

	it('groups the scenes into chapters in reading order when it does not', () => {
		const unit = bookPatternUnit(scenes, titles, false);
		expect(unit.whole).toBeUndefined();
		expect(unit.chapters?.map((c) => c.map((s) => s.id))).toEqual([['a', 'b'], ['c'], ['d']]);
	});
});

describe('patternSurveyTokens', () => {
	const scenes = Array.from({ length: 4 }, (_, i) => ({
		id: `s${i}`,
		title: null,
		bodyMd: 'word '.repeat(500),
		chapterId: i < 2 ? 'c1' : 'c2'
	}));
	const titles = new Map([
		['c1', 'One'],
		['c2', 'Two']
	]);

	it('counts one request for the whole book and one per chapter otherwise', () => {
		const whole = patternSurveyTokens([bookPatternUnit(scenes, titles, true)], 100, 50);
		const byChapter = patternSurveyTokens([bookPatternUnit(scenes, titles, false)], 100_000, 50);
		// The same text either way; the chapter route pays the overhead twice.
		expect(byChapter - whole).toBeGreaterThan(40);
		expect(whole).toBeGreaterThan(4 * 500);
	});
});
