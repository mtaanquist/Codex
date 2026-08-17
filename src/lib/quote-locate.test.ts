import { describe, it, expect } from 'vitest';
import { locateQuote } from './quote-locate';

const CURLY_OPEN = '\u201c';
const CURLY_CLOSE = '\u201d';
const APOSTROPHE = '\u2019';

describe('locateQuote', () => {
	const body = 'She said "run" and he ran.\n\nThe dog\'s bark  faded behind them.';

	it('locates an exact passage', () => {
		const result = locateQuote(body, 'and he ran');
		const start = body.indexOf('and he ran');
		expect(result).toEqual({ ok: true, start, end: start + 'and he ran'.length });
	});

	it('locates a passage quoted back with curly quotes', () => {
		const result = locateQuote(body, `${CURLY_OPEN}run${CURLY_CLOSE}`);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(body.slice(result.start, result.end)).toBe('"run"');
	});

	it('locates a passage quoted back with a curly apostrophe', () => {
		const result = locateQuote(body, `The dog${APOSTROPHE}s bark`);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(body.slice(result.start, result.end)).toBe("The dog's bark");
	});

	it('locates a passage whose whitespace runs differ', () => {
		const result = locateQuote(body, 'bark faded behind');
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(body.slice(result.start, result.end)).toBe('bark  faded behind');
	});

	it('maps a match spanning a paragraph break back onto the original body', () => {
		const result = locateQuote(body, 'he ran. The dog' + APOSTROPHE + 's');
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(body.slice(result.start, result.end)).toBe("he ran.\n\nThe dog's");
	});

	it('reports an ambiguous normalised match', () => {
		const repeated =
			'He said ' +
			CURLY_OPEN +
			'no' +
			CURLY_CLOSE +
			' twice. He said ' +
			CURLY_OPEN +
			'no' +
			CURLY_CLOSE +
			' twice.';
		expect(locateQuote(repeated, 'He said "no" twice.')).toEqual({
			ok: false,
			reason: 'ambiguous'
		});
	});

	it('prefers a unique exact match over a normalised twin elsewhere', () => {
		const mixed = 'He said ' + CURLY_OPEN + 'no' + CURLY_CLOSE + ' twice. He said "no" twice.';
		const result = locateQuote(mixed, 'He said "no" twice.');
		expect(result).toEqual({
			ok: true,
			start: mixed.indexOf('He said "no"'),
			end: mixed.length
		});
	});

	it('reports an ambiguous exact match', () => {
		expect(locateQuote('run and run', 'run')).toEqual({ ok: false, reason: 'ambiguous' });
	});

	it('reports a genuine miss', () => {
		expect(locateQuote(body, 'nothing like this text')).toEqual({ ok: false, reason: 'missing' });
		expect(locateQuote(body, '')).toEqual({ ok: false, reason: 'missing' });
		expect(locateQuote(body, '   ')).toEqual({ ok: false, reason: 'missing' });
	});

	it('trims the quote so the offsets never end inside a whitespace run', () => {
		const result = locateQuote(body, '  and he ran  ');
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(body.slice(result.start, result.end)).toBe('and he ran');
	});
});
