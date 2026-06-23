import { describe, it, expect } from 'vitest';
import { detectStructure, markdownToBlocks, type DocBlock } from './import-document-structure';

const para = (md: string): DocBlock => ({ kind: 'para', md });
const heading = (level: number, text: string): DocBlock => ({ kind: 'heading', level, text });

describe('detectStructure', () => {
	it('splits chapters on the shallowest repeating heading level', () => {
		const { chapters } = detectStructure([
			heading(1, 'Chapter 1'),
			para('Opening prose.'),
			heading(1, 'Chapter 2'),
			para('More prose.')
		]);
		expect(chapters).toHaveLength(2);
		expect(chapters[0].title).toBeNull(); // "Chapter 1" is generic -> default
		expect(chapters[0].scenes).toHaveLength(1);
		expect(chapters[0].scenes[0].bodyMd).toBe('Opening prose.');
		expect(chapters[1].scenes[0].bodyMd).toBe('More prose.');
	});

	it('keeps a descriptive chapter title but drops a generic label', () => {
		const { chapters } = detectStructure([
			heading(2, 'Chapter 1: The Road'),
			para('a'),
			heading(2, 'Prologue'),
			para('b'),
			heading(2, 'Chapter Two'),
			para('c')
		]);
		expect(chapters.map((c) => c.title)).toEqual(['Chapter 1: The Road', 'Prologue', null]);
	});

	it('treats a lone top heading as a book title, not a chapter', () => {
		const { chapters } = detectStructure([
			heading(1, 'My Novel'),
			heading(2, 'Chapter 1'),
			para('a'),
			heading(2, 'Chapter 2'),
			para('b')
		]);
		// h1 appears once -> not the chapter level; h2 repeats -> chapters.
		expect(chapters).toHaveLength(2);
	});

	it('splits scenes on deeper headings and on scene-break glyphs', () => {
		const { chapters } = detectStructure([
			heading(1, 'One'),
			para('Scene one.'),
			para('* * *'),
			para('Scene two.'),
			heading(2, 'A titled scene'),
			para('Scene three.')
		]);
		expect(chapters).toHaveLength(1);
		const scenes = chapters[0].scenes;
		expect(scenes).toHaveLength(3);
		expect(scenes[0].bodyMd).toBe('Scene one.');
		expect(scenes[1].bodyMd).toBe('Scene two.');
		expect(scenes[2].title).toBe('A titled scene');
		expect(scenes[2].bodyMd).toBe('Scene three.');
	});

	it('detects chapters from "Chapter N" paragraphs when there are no headings', () => {
		const { chapters } = detectStructure([
			para('Chapter One'),
			para('Prose a.'),
			para('Chapter Two'),
			para('Prose b.')
		]);
		expect(chapters).toHaveLength(2);
		expect(chapters.every((c) => c.title === null)).toBe(true);
	});

	it('recognises bare numeral and upper-case roman chapter markers', () => {
		const { chapters } = detectStructure([para('1'), para('a'), para('II'), para('b')]);
		expect(chapters).toHaveLength(2);
	});

	it('does not treat a lower-case roman-letter word as a chapter', () => {
		const { chapters } = detectStructure([para('did'), para('mill the grain')]);
		expect(chapters).toHaveLength(1);
		expect(chapters[0].scenes).toHaveLength(1);
	});

	it('falls back to one chapter and one scene with no structure', () => {
		const { chapters, problems } = detectStructure([
			para('Just a paragraph.'),
			para('And another.')
		]);
		expect(chapters).toHaveLength(1);
		expect(chapters[0].title).toBeNull();
		expect(chapters[0].scenes).toHaveLength(1);
		expect(chapters[0].scenes[0].bodyMd).toBe('Just a paragraph.\n\nAnd another.');
		expect(problems.some((p) => p.includes('single scene'))).toBe(true);
	});

	it('gives a chapter with no inner breaks a single scene of all its prose', () => {
		const { chapters } = detectStructure([
			heading(1, 'Chapter 1'),
			para('p1'),
			para('p2'),
			heading(1, 'Chapter 2'),
			para('p3')
		]);
		expect(chapters[0].scenes).toHaveLength(1);
		expect(chapters[0].scenes[0].bodyMd).toBe('p1\n\np2');
	});

	it('folds prose before the first chapter into an implicit first chapter', () => {
		const { chapters } = detectStructure([
			para('Front matter line.'),
			para('Chapter One'),
			para('Body.')
		]);
		expect(chapters).toHaveLength(2);
		expect(chapters[0].title).toBeNull();
		expect(chapters[0].scenes[0].bodyMd).toBe('Front matter line.');
		expect(chapters[1].scenes[0].bodyMd).toBe('Body.');
	});

	it('reports a problem and yields one empty scene for an empty document', () => {
		const { chapters, problems } = detectStructure([]);
		expect(chapters).toHaveLength(1);
		expect(chapters[0].scenes).toHaveLength(1);
		expect(chapters[0].scenes[0].bodyMd).toBe('');
		expect(problems.some((p) => p.includes('No readable text'))).toBe(true);
	});
});

describe('markdownToBlocks', () => {
	it('reads ATX headings and blank-line separated paragraphs', () => {
		const blocks = markdownToBlocks('# Title\n\nA paragraph.\n\n## Sub\n\n- a\n- b');
		expect(blocks).toEqual([
			{ kind: 'heading', level: 1, text: 'Title' },
			{ kind: 'para', md: 'A paragraph.' },
			{ kind: 'heading', level: 2, text: 'Sub' },
			{ kind: 'para', md: '- a\n- b' }
		]);
	});

	it('keeps a multi-line block that merely starts with a hash as a paragraph', () => {
		const blocks = markdownToBlocks('# A heading\nwith a second line');
		expect(blocks).toEqual([{ kind: 'para', md: '# A heading\nwith a second line' }]);
	});
});
