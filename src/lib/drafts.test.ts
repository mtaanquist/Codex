import { describe, it, expect } from 'vitest';
import { draftOutline, suggestDraftName, type DraftScene } from './drafts';

function scene(id: string, chapterId: string | null): DraftScene {
	return {
		id,
		chapterId,
		title: id,
		bodyMd: '',
		summaryMd: null,
		status: 'draft',
		storyTime: null,
		wordCount: 0
	};
}

describe('draftOutline', () => {
	it('groups scenes under their chapters in order, then the unfiled ones', () => {
		const outline = draftOutline({
			chapters: [
				{ id: 'c1', title: 'One', summaryMd: null },
				{ id: 'c2', title: 'Two', summaryMd: null }
			],
			scenes: [scene('a', 'c2'), scene('b', null), scene('c', 'c1'), scene('d', 'c2')]
		});
		expect(outline.chapters.map((c) => [c.id, c.scenes.map((s) => s.id)])).toEqual([
			['c1', ['c']],
			['c2', ['a', 'd']]
		]);
		expect(outline.unfiled.map((s) => s.id)).toEqual(['b']);
	});

	it('treats a scene whose chapter is missing as unfiled, so no scene is lost', () => {
		const outline = draftOutline({ chapters: [], scenes: [scene('a', 'gone')] });
		expect(outline.unfiled.map((s) => s.id)).toEqual(['a']);
	});
});

describe('suggestDraftName', () => {
	it('counts on from the drafts there are', () => {
		expect(suggestDraftName([])).toBe('First draft');
		expect(suggestDraftName(['First draft'])).toBe('Second draft');
		expect(suggestDraftName(['A', 'B'])).toBe('Third draft');
	});

	it('switches to numbers after the twelfth', () => {
		expect(suggestDraftName(Array.from({ length: 12 }, (_, i) => `D${i}`))).toBe('Draft 13');
	});

	it('steps past a name already in use', () => {
		expect(suggestDraftName(['second draft'])).toBe('Third draft');
		expect(suggestDraftName(['Second draft', 'Third draft'])).toBe('Fourth draft');
	});
});
