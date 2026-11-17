import { describe, it, expect } from 'vitest';
import { compareDrafts, draftOutline, matchScenes, type DraftScene } from './drafts';

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

describe('compareDrafts', () => {
	const text = (id: string, bodyMd: string, extra: Partial<DraftScene> = {}): DraftScene => ({
		...scene(id, 'c1'),
		bodyMd,
		wordCount: bodyMd.split(' ').length,
		...extra
	});
	const chapters = [{ id: 'c1', title: 'One', summaryMd: null }];

	it('marks scenes same, changed, added and removed, in the newer order', () => {
		const result = compareDrafts(
			{ chapters, scenes: [text('a', 'kept'), text('b', 'old words'), text('c', 'gone')] },
			{ chapters, scenes: [text('n', 'brand new'), text('b', 'new words'), text('a', 'kept')] }
		);
		expect(
			result.changes.map((change) => [change.kind, change.after?.id ?? change.before?.id])
		).toEqual([
			['added', 'n'],
			['changed', 'b'],
			['removed', 'c']
		]);
		expect(result.counts).toEqual({ same: 1, changed: 1, added: 1, removed: 1 });
		expect(result.words).toEqual({ before: 4, after: 5 });
		expect(result.changes[0].chapterTitle).toBe('One');
	});

	it('matches a scene added back from a draft by where it came from', () => {
		const result = compareDrafts(
			{ chapters, scenes: [text('a', 'back again')] },
			{ chapters, scenes: [text('copy', 'back again', { origin: 'a', title: 'a' })] }
		);
		expect(result.counts).toEqual({ same: 1, changed: 0, added: 0, removed: 0 });
	});

	it('counts a title change as a change', () => {
		const result = compareDrafts(
			{ chapters, scenes: [text('a', 'same', { title: 'Old' })] },
			{ chapters, scenes: [text('a', 'same', { title: 'New' })] }
		);
		expect(result.counts.changed).toBe(1);
	});
});

describe('matchScenes', () => {
	it('lets the same id win over a copy that came from it', () => {
		// "a" was added back as "copy", then "a" itself came back from the trash
		// and now reads after the copy.
		const pairs = matchScenes([{ id: 'a' }], [{ id: 'copy', origin: 'a' }, { id: 'a' }]);
		expect([...pairs]).toEqual([['a', 'a']]);
	});

	it('follows a scene added back twice to the first draft', () => {
		expect([...matchScenes([{ id: 'a' }], [{ id: 'c', origin: 'b', root: 'a' }])]).toEqual([
			['c', 'a']
		]);
		expect([...matchScenes([{ id: 'b' }], [{ id: 'c', origin: 'b', root: 'a' }])]).toEqual([
			['c', 'b']
		]);
	});

	it('pairs each older scene once', () => {
		const pairs = matchScenes(
			[{ id: 'a' }],
			[
				{ id: 'x', origin: 'a' },
				{ id: 'y', origin: 'a' }
			]
		);
		expect([...pairs]).toEqual([['x', 'a']]);
	});
});
