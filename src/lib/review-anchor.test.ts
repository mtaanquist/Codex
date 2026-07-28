import { describe, it, expect } from 'vitest';
import { createAnchorMapper, reanchorPoint, reanchorRange } from './review-anchor';

const BASE = 'The quick brown fox jumps over the lazy dog.';
// Anchor "brown fox" = [10, 19).
const START = BASE.indexOf('brown');
const END = START + 'brown fox'.length;

describe('reanchorRange', () => {
	it('returns the range unchanged when the text is unchanged', () => {
		expect(reanchorRange(BASE, BASE, START, END)).toEqual({ start: START, end: END });
	});

	it('shifts the range when text changes before it', () => {
		const current = 'A very ' + BASE;
		const result = reanchorRange(BASE, current, START, END);
		expect(result).toEqual({ start: START + 7, end: END + 7 });
		expect(current.slice(result!.start, result!.end)).toBe('brown fox');
	});

	it('keeps the range in place when text changes after it', () => {
		const current = BASE.replace('lazy dog', 'sleeping cat');
		expect(reanchorRange(BASE, current, START, END)).toEqual({ start: START, end: END });
	});

	it('stretches over an insertion inside the range', () => {
		const current = BASE.replace('brown fox', 'brown furry fox');
		const result = reanchorRange(BASE, current, START, END);
		expect(current.slice(result!.start, result!.end)).toBe('brown furry fox');
	});

	it('shrinks over a deletion inside the range', () => {
		const current = BASE.replace('quick brown fox', 'quick fox');
		// Anchor "quick brown fox".
		const s = BASE.indexOf('quick');
		const e = s + 'quick brown fox'.length;
		const result = reanchorRange(BASE, current, s, e);
		expect(current.slice(result!.start, result!.end)).toBe('quick fox');
	});

	it('loses the anchor when its text is rewritten', () => {
		const current = BASE.replace('brown fox', 'red vixen');
		expect(reanchorRange(BASE, current, START, END)).toBeNull();
	});

	it('loses the anchor when the range is deleted entirely', () => {
		const current = BASE.replace('brown fox ', '');
		expect(reanchorRange(BASE, current, START, END)).toBeNull();
	});

	it('rejects a degenerate or out-of-bounds range', () => {
		expect(reanchorRange(BASE, BASE, 5, 5)).toBeNull();
		expect(reanchorRange(BASE, BASE, -1, 5)).toBeNull();
		expect(reanchorRange(BASE, BASE, 0, BASE.length + 1)).toBeNull();
	});

	it('survives an edit at the very start and end of the text', () => {
		const current = 'Lo! ' + BASE.slice(0, -1) + '!';
		const result = reanchorRange(BASE, current, START, END);
		expect(current.slice(result!.start, result!.end)).toBe('brown fox');
	});
});

describe('reanchorPoint', () => {
	it('maps a position through surrounding edits', () => {
		const pos = BASE.indexOf('fox');
		expect(reanchorPoint(BASE, BASE, pos)).toBe(pos);
		expect(reanchorPoint(BASE, 'Lo! ' + BASE, pos)).toBe(pos + 4);
		expect(reanchorPoint(BASE, BASE.replace('lazy dog', 'cat'), pos)).toBe(pos);
	});

	it('survives at the start and end of the text', () => {
		expect(reanchorPoint(BASE, 'X' + BASE, 0)).not.toBeNull();
		expect(reanchorPoint(BASE, BASE + '!', BASE.length)).toBe(BASE.length);
	});

	it('loses a position whose surrounding text was removed', () => {
		const pos = BASE.indexOf('brown') + 2;
		expect(reanchorPoint(BASE, BASE.replace('brown fox', 'X'), pos)).toBeNull();
	});

	it('rejects out-of-bounds positions', () => {
		expect(reanchorPoint(BASE, BASE, -1)).toBeNull();
		expect(reanchorPoint(BASE, BASE, BASE.length + 1)).toBeNull();
	});
});

describe('createAnchorMapper', () => {
	// The mapper reuses one diff per pair of texts, so what it returns has to
	// stay identical to re-anchoring each anchor on its own.
	const CASES: Array<[string, string]> = [
		[BASE, BASE],
		[BASE, 'A very ' + BASE],
		[BASE, BASE.replace('lazy dog', 'sleeping cat')],
		[BASE, BASE.replace('brown fox', 'brown furry fox')],
		[BASE, BASE.replace('brown fox', 'red vixen')],
		[BASE, BASE.replace('brown fox ', '')]
	];

	it('matches reanchorRange on every offset', () => {
		const mapper = createAnchorMapper();
		for (const [base, current] of CASES) {
			for (let start = 0; start < base.length; start++) {
				for (let end = start; end <= base.length + 1; end++) {
					expect(mapper.range(base, current, start, end)).toEqual(
						reanchorRange(base, current, start, end)
					);
				}
			}
		}
	});

	it('matches reanchorPoint on every position', () => {
		const mapper = createAnchorMapper();
		for (const [base, current] of CASES) {
			for (let position = -1; position <= base.length + 1; position++) {
				expect(mapper.point(base, current, position)).toEqual(
					reanchorPoint(base, current, position)
				);
			}
		}
	});

	it('keeps separate results for different current texts against one base', () => {
		const mapper = createAnchorMapper();
		const shifted = 'A very ' + BASE;
		const rewritten = BASE.replace('brown fox', 'red vixen');
		expect(mapper.range(BASE, shifted, START, END)).toEqual({ start: START + 7, end: END + 7 });
		expect(mapper.range(BASE, rewritten, START, END)).toBeNull();
		// Repeating the first pair still maps through its own diff, not the second's.
		expect(mapper.range(BASE, shifted, START, END)).toEqual({ start: START + 7, end: END + 7 });
	});

	it('diffs each pair of texts once however many anchors map through it', () => {
		const mapper = createAnchorMapper();
		const current = BASE.replace('lazy dog', 'sleeping cat');
		const first = mapper.range(BASE, current, START, END);
		const t0 = performance.now();
		for (let i = 0; i < 1000; i++) mapper.range(BASE, current, START, END);
		// A thousand cached maps cost far less than a thousand diffs would.
		expect(performance.now() - t0).toBeLessThan(50);
		expect(mapper.range(BASE, current, START, END)).toEqual(first);
	});
});
