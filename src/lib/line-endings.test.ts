import { describe, it, expect } from 'vitest';
import { lfOffset, toLf } from './line-endings';

describe('toLf', () => {
	it('turns Windows and old Mac line breaks into newlines', () => {
		expect(toLf('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
		expect(toLf('no breaks')).toBe('no breaks');
	});
});

describe('lfOffset', () => {
	it('keeps an offset on the same character once the breaks are normalised', () => {
		const text = 'one\r\ntwo\r\n\r\nthree';
		for (const word of ['one', 'two', 'three']) {
			expect(
				toLf(text)
					.slice(lfOffset(text, text.indexOf(word)))
					.startsWith(word)
			).toBe(true);
		}
		expect(lfOffset(text, text.length)).toBe(toLf(text).length);
	});

	it('puts an offset between \\r and \\n on the newline', () => {
		expect(lfOffset('a\r\nb', 2)).toBe(1);
		expect(toLf('a\r\nb')[1]).toBe('\n');
	});
});
