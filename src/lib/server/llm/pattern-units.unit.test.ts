import { describe, expect, it } from 'vitest';
import { chapterPatternUnits } from './scene-review';

const scene = (id: string, chapterId: string | null) => ({
	id,
	title: id,
	chapterId,
	bodyMd: `Text of ${id}.`
});

describe('chapterPatternUnits', () => {
	it('groups scenes by chapter in order, unfiled scenes together', () => {
		const units = chapterPatternUnits([
			scene('a', 'c1'),
			scene('b', 'c2'),
			scene('c', 'c1'),
			scene('d', null),
			scene('e', 'c2'),
			scene('f', null)
		]);
		expect(units.map((u) => [u.key, u.scope, u.scenes.map((s) => s.id)])).toEqual([
			['c1', 'chapter', ['a', 'c']],
			['c2', 'chapter', ['b', 'e']],
			['unfiled', 'chapter', ['d', 'f']]
		]);
	});

	it('skips a chapter with one scene, where nothing can repeat across scenes', () => {
		expect(chapterPatternUnits([scene('a', 'c1'), scene('b', 'c2'), scene('c', 'c2')])).toEqual([
			expect.objectContaining({ key: 'c2' })
		]);
	});
});
