import { describe, it, expect } from 'vitest';
import {
	compareDrafts,
	draftOutline,
	matchScenes,
	suggestDraftName,
	type DraftScene
} from './drafts';

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
		expect(result.changes[0].notes).toEqual(['Renamed from "Old"']);
	});

	it('counts a status or summary change as a change and says which', () => {
		const result = compareDrafts(
			{ chapters, scenes: [text('a', 'same', { summaryMd: 'Old summary.' })] },
			{ chapters, scenes: [text('a', 'same', { summaryMd: 'New.', status: 'revised' })] }
		);
		expect(result.counts.changed).toBe(1);
		expect(result.changes[0].notes).toEqual([
			'Status changed from Draft to Revised',
			'Summary changed'
		]);
	});

	it('names the chapter a scene moved from', () => {
		const two = [...chapters, { id: 'c2', title: null, summaryMd: null }];
		const result = compareDrafts(
			{ chapters: two, scenes: [text('a', 'same')] },
			{ chapters: two, scenes: [text('a', 'same', { chapterId: 'c2' })] }
		);
		expect(result.changes[0].notes).toEqual(['Moved from One']);
	});

	it('marks only the scene that moved, not the ones it passed', () => {
		const ids = ['a', 'b', 'c', 'd'];
		const result = compareDrafts(
			{ chapters, scenes: ids.map((id) => text(id, id)) },
			{ chapters, scenes: ['b', 'c', 'd', 'a'].map((id) => text(id, id)) }
		);
		expect(result.changes.map((change) => [change.after!.id, change.notes])).toEqual([
			['a', ['Moved to another place in its chapter']]
		]);
		expect(result.counts.same).toBe(3);
	});

	it('does not mark scenes as moved when one is added before them', () => {
		const result = compareDrafts(
			{ chapters, scenes: [text('a', 'a'), text('b', 'b')] },
			{ chapters, scenes: [text('n', 'n'), text('a', 'a'), text('b', 'b')] }
		);
		expect(result.counts).toEqual({ same: 2, changed: 0, added: 1, removed: 0 });
	});

	it('lists a moved chapter once instead of marking its scenes', () => {
		const two = [...chapters, { id: 'c2', title: 'Two', summaryMd: null }];
		const scenes = [text('a', 'a'), text('b', 'b'), text('c', 'c', { chapterId: 'c2' })];
		const result = compareDrafts({ chapters: two, scenes }, { chapters: [two[1], two[0]], scenes });
		expect(result.counts).toEqual({ same: 3, changed: 0, added: 0, removed: 0 });
		// A swap of two reads as either one moving; one line is enough.
		expect(result.chapterMoves).toHaveLength(1);
	});

	it('does not list chapters as moved when one is added in front', () => {
		const added = [{ id: 'c0', title: 'Zero', summaryMd: null }, ...chapters];
		const result = compareDrafts({ chapters, scenes: [] }, { chapters: added, scenes: [] });
		expect(result.chapterMoves).toEqual([]);
	});

	it('checks unfiled scenes as one group', () => {
		const result = compareDrafts(
			{
				chapters: [],
				scenes: [text('a', 'a', { chapterId: null }), text('b', 'b', { chapterId: 'gone' })]
			},
			{
				chapters: [],
				scenes: [text('b', 'b', { chapterId: 'gone' }), text('a', 'a', { chapterId: null })]
			}
		);
		expect(result.counts.changed).toBe(1);
	});

	it('still marks a scene moved inside its chapter', () => {
		const result = compareDrafts(
			{ chapters, scenes: [text('a', 'a'), text('b', 'b')] },
			{ chapters, scenes: [text('b', 'b'), text('a', 'a')] }
		);
		expect(result.counts.changed).toBe(1);
		expect(result.chapterMoves).toEqual([]);
	});

	it('lists renamed chapters', () => {
		const result = compareDrafts(
			{ chapters, scenes: [] },
			{ chapters: [{ id: 'c1', title: 'The Toll', summaryMd: null }], scenes: [] }
		);
		expect(result.chapterRenames).toEqual([{ id: 'c1', before: 'One', after: 'The Toll' }]);
	});

	it('does not list an untitled chapter given its own fallback name', () => {
		const result = compareDrafts(
			{ chapters: [{ id: 'c1', title: null, summaryMd: null }], scenes: [] },
			{ chapters: [{ id: 'c1', title: 'Chapter 1', summaryMd: null }], scenes: [] }
		);
		expect(result.chapterRenames).toEqual([]);
	});

	it('does not mark a scene as moved when another scene changed chapter past it', () => {
		const two = [...chapters, { id: 'c2', title: 'Two', summaryMd: null }];
		const result = compareDrafts(
			{ chapters: two, scenes: [text('a', 'a'), text('b', 'b', { chapterId: 'c2' })] },
			{
				chapters: two,
				scenes: [text('b', 'b', { chapterId: 'c2' }), text('a', 'a', { chapterId: 'c2' })]
			}
		);
		expect(result.changes.map((change) => [change.after!.id, change.notes])).toEqual([
			['a', ['Moved from One']]
		]);
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

	it('starts past the highest numbered name, so deletes never step back', () => {
		expect(suggestDraftName(['Third draft'])).toBe('Fourth draft');
		expect(suggestDraftName(['third DRAFT ', 'Notes'])).toBe('Fourth draft');
		expect(suggestDraftName(['Draft 14'])).toBe('Draft 15');
		expect(suggestDraftName(['Draft 9007199254740992'])).toBe('Second draft');
	});
});
