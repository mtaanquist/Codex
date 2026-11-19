import { describe, expect, it } from 'vitest';
import { paragraphSpans, paragraphWindow } from './paragraphs';

const body = 'One para.\n\nTwo para here.\n\n  \nThree.\n\nFour last.';
const text = (span: { start: number; end: number }) => body.slice(span.start, span.end);

describe('paragraphSpans', () => {
	it('splits on blank lines, including whitespace-only ones, and trims each paragraph', () => {
		expect(paragraphSpans(body).map(text)).toEqual([
			'One para.',
			'Two para here.',
			'Three.',
			'Four last.'
		]);
	});

	it('keeps single line breaks inside a paragraph', () => {
		expect(paragraphSpans('a line\nand the next\n\nb').map((s) => s.end - s.start)).toEqual([
			19, 1
		]);
	});

	it('returns nothing for an empty or blank body', () => {
		expect(paragraphSpans('')).toEqual([]);
		expect(paragraphSpans('\n\n  \n')).toEqual([]);
	});
});

describe('paragraphWindow', () => {
	const at = (needle: string) => body.indexOf(needle);

	it('is the paragraph holding the range', () => {
		const start = at('para here');
		expect(text(paragraphWindow(body, start, start + 4))).toBe('Two para here.');
	});

	it('adds neighbours on each side, clamped at the ends', () => {
		const start = at('Three');
		expect(text(paragraphWindow(body, start, start + 5, 1))).toBe(
			'Two para here.\n\n  \nThree.\n\nFour last.'
		);
		expect(text(paragraphWindow(body, 0, 3, 1))).toBe('One para.\n\nTwo para here.');
	});

	it('spans every paragraph a range crosses', () => {
		expect(text(paragraphWindow(body, at('para.'), at('Two') + 3))).toBe(
			'One para.\n\nTwo para here.'
		);
	});

	it('treats a point at a paragraph end as inside it, and one in a gap as the next', () => {
		const end = at('One para.') + 'One para.'.length;
		expect(text(paragraphWindow(body, end, end))).toBe('One para.');
		expect(text(paragraphWindow(body, end + 1, end + 1))).toBe('Two para here.');
	});

	it('falls back to the last paragraph past the end, and the whole body when empty', () => {
		expect(text(paragraphWindow(body, body.length + 5, body.length + 5))).toBe('Four last.');
		expect(paragraphWindow('', 0, 0)).toEqual({ start: 0, end: 0 });
	});
});
