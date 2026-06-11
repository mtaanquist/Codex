import { describe, it, expect } from 'vitest';
import { filterChapter, filterOrphanScenes } from './outline-filter';

const scenes = [
	{ id: 'a', title: 'The harbour' },
	{ id: 'b', title: null },
	{ id: 'c', title: 'Checkpoint' }
];

describe('filterChapter', () => {
	it('keeps every scene with no search active', () => {
		const result = filterChapter('', 'Night crossing', 'Chapter 1', scenes);
		expect(result).toMatchObject({ chapterMatch: true, visible: true });
		expect(result.scenes).toHaveLength(3);
	});

	it('a matching chapter keeps all its scenes', () => {
		const result = filterChapter('crossing', 'Night crossing', 'Chapter 1', scenes);
		expect(result.chapterMatch).toBe(true);
		expect(result.scenes).toHaveLength(3);
	});

	it('a non-matching chapter shows only matching scenes', () => {
		const result = filterChapter('harbour', 'Night crossing', 'Chapter 1', scenes);
		expect(result.chapterMatch).toBe(false);
		expect(result.scenes.map((s) => s.id)).toEqual(['a']);
		expect(result.visible).toBe(true);
	});

	it('a chapter with nothing left hides', () => {
		const result = filterChapter('volcano', 'Night crossing', 'Chapter 1', scenes);
		expect(result.visible).toBe(false);
	});

	it('untitled rows match by their fallback labels', () => {
		expect(filterChapter('chapter 2', null, 'Chapter 2', scenes).chapterMatch).toBe(true);
		const result = filterChapter('untitled', 'Named', 'Chapter 1', scenes);
		expect(result.scenes.map((s) => s.id)).toEqual(['b']);
	});

	it('trims and lower-cases the query', () => {
		expect(filterChapter('  NIGHT  ', 'Night crossing', 'Chapter 1', scenes).chapterMatch).toBe(
			true
		);
	});
});

describe('filterOrphanScenes', () => {
	it('passes through without a query and filters with one', () => {
		expect(filterOrphanScenes('', scenes)).toHaveLength(3);
		expect(filterOrphanScenes('check', scenes).map((s) => s.id)).toEqual(['c']);
	});
});
