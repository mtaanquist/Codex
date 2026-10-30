import { describe, expect, it } from 'vitest';
import { withoutRanges } from './editor-images';

describe('withoutRanges', () => {
	const text = 'Before. ![Uploading a.png...]()\nAfter.';
	const from = text.indexOf('!');
	const to = text.indexOf('After.');

	it('leaves an uploading placeholder out of the stored text', () => {
		expect(withoutRanges(text, [{ from, to }]).text).toBe('Before. After.');
	});

	it('moves positions after a placeholder back by its length', () => {
		const { mapPos } = withoutRanges(text, [{ from, to }]);
		expect(mapPos(3)).toBe(3);
		expect(mapPos(to)).toBe(from);
		expect(mapPos(text.length)).toBe('Before. After.'.length);
		expect(mapPos(from + 4)).toBe(from);
	});

	it('handles several placeholders in any order', () => {
		const result = withoutRanges('a[x]b[y]c', [
			{ from: 5, to: 8 },
			{ from: 1, to: 4 }
		]);
		expect(result.text).toBe('abc');
		expect(result.mapPos(9)).toBe(3);
	});

	it('returns the text unchanged with nothing uploading', () => {
		expect(withoutRanges('Plain.', []).text).toBe('Plain.');
	});
});
