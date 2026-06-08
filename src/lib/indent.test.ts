import { describe, it, expect } from 'vitest';
import { indentMarker, indentOf, MAX_INDENT } from './indent';
import { renderMarkdown } from './markdown';

describe('indentOf', () => {
	it('reads the bare marker as level 1', () => {
		expect(indentOf('\\indent Hello')).toEqual({ level: 1, markerLength: 8 });
	});
	it('reads a numbered marker', () => {
		expect(indentOf('\\indent3 Hello')).toEqual({ level: 3, markerLength: 9 });
	});
	it('clamps a runaway level', () => {
		expect(indentOf('\\indent99 x')?.level).toBe(MAX_INDENT);
	});
	it('is null for plain prose', () => {
		expect(indentOf('Just prose')).toBeNull();
		expect(indentOf('\\indentish nope')).toBeNull();
	});
});

describe('indentMarker', () => {
	it('writes the bare marker for level 1 and a numbered one above', () => {
		expect(indentMarker(1)).toBe('\\indent ');
		expect(indentMarker(3)).toBe('\\indent3 ');
	});
	it('is empty at level 0', () => {
		expect(indentMarker(0)).toBe('');
	});
});

describe('renderMarkdown with indents', () => {
	it('strips the marker and shifts the paragraph right', () => {
		const html = renderMarkdown('\\indent2 A line.');
		expect(html).toContain('margin-left: calc(2 * 1.5em)');
		expect(html).toContain('A line.');
		expect(html).not.toContain('\\indent');
	});
	it('combines with an alignment marker', () => {
		const html = renderMarkdown('\\center \\indent2 Centered and indented.');
		expect(html).toContain('class="align-center"');
		expect(html).toContain('margin-left: calc(2 * 1.5em)');
		expect(html).not.toContain('\\indent');
		expect(html).not.toContain('\\center');
	});
});
