import { describe, it, expect } from 'vitest';
import type { DecorationSet } from '@codemirror/view';
import { buildReviewMarks } from './editor-review-marks';
import type { ReviewFilter, ReviewSuggestion, ReviewThread } from './review-ui';

// A flattened view of a decoration, enough to assert against without a DOM.
type Flat = {
	from: number;
	to: number;
	class?: string;
	rid?: string;
	widgetText?: string;
};

function flatten(set: DecorationSet): Flat[] {
	const out: Flat[] = [];
	const cursor = set.iter();
	while (cursor.value) {
		const spec = cursor.value.spec as {
			class?: string;
			attributes?: Record<string, string>;
			widget?: { text?: string };
		};
		out.push({
			from: cursor.from,
			to: cursor.to,
			class: spec.class,
			rid: spec.attributes?.['data-rid'],
			widgetText: spec.widget?.text
		});
		cursor.next();
	}
	return out;
}

function thread(over: Partial<ReviewThread> = {}): ReviewThread {
	return {
		id: 't1',
		sceneId: 's1',
		anchor: { start: 2, end: 6 },
		anchorLost: false,
		resolvedAt: null,
		createdAt: '2026-01-01',
		comments: [
			{
				id: 'c1',
				body: 'note',
				authorName: 'Ada',
				isOwner: false,
				isAssistant: false,
				mine: false,
				createdAt: '2026-01-01'
			}
		],
		...over
	};
}

function suggestion(over: Partial<ReviewSuggestion> = {}): ReviewSuggestion {
	return {
		id: 'g1',
		sceneId: 's1',
		reviewerName: 'Ada',
		isOwner: false,
		isAssistant: false,
		mine: false,
		original: 'cat',
		replacement: 'dog',
		status: 'pending',
		anchor: { start: 4, end: 7 },
		anchorLost: false,
		createdAt: '2026-01-01',
		...over
	};
}

const ALL: ReviewFilter = 'all';

describe('buildReviewMarks', () => {
	it('marks an open, anchored comment over its passage', () => {
		const flat = flatten(buildReviewMarks([thread()], [], ALL, 100));
		expect(flat).toHaveLength(1);
		expect(flat[0]).toMatchObject({ from: 2, to: 6, rid: 't1' });
		expect(flat[0].class).toContain('rv-comment');
	});

	it('hides comments under the suggestions filter and vice versa', () => {
		expect(flatten(buildReviewMarks([thread()], [], 'suggestions', 100))).toHaveLength(0);
		expect(flatten(buildReviewMarks([], [suggestion()], 'comments', 100))).toHaveLength(0);
	});

	it('excludes resolved threads and decided suggestions', () => {
		expect(
			flatten(buildReviewMarks([thread({ resolvedAt: '2026-02-01' })], [], ALL, 100))
		).toHaveLength(0);
		expect(
			flatten(buildReviewMarks([], [suggestion({ status: 'accepted' })], ALL, 100))
		).toHaveLength(0);
	});

	it('draws a delete suggestion as a strikethrough mark over the text', () => {
		const flat = flatten(buildReviewMarks([], [suggestion({ replacement: '' })], ALL, 100));
		expect(flat).toHaveLength(1);
		expect(flat[0]).toMatchObject({ from: 4, to: 7, rid: 'g1' });
		expect(flat[0].class).toContain('rv-del');
	});

	it('rides an insert suggestion as a ghost widget at the anchor', () => {
		const flat = flatten(
			buildReviewMarks([], [suggestion({ original: '', replacement: 'new' })], ALL, 100)
		);
		expect(flat).toHaveLength(1);
		expect(flat[0].from).toBe(flat[0].to);
		expect(flat[0].from).toBe(4);
		expect(flat[0].widgetText).toBe('new');
	});

	it('draws a replace as a strikethrough mark plus a ghost widget at the end', () => {
		const flat = flatten(buildReviewMarks([], [suggestion()], ALL, 100));
		expect(flat).toHaveLength(2);
		const mark = flat.find((f) => f.class?.includes('rv-replace'));
		const ghost = flat.find((f) => f.widgetText);
		expect(mark).toMatchObject({ from: 4, to: 7 });
		expect(ghost).toMatchObject({ from: 7, to: 7, widgetText: 'dog' });
	});

	it('skips anchors that fall outside the live document', () => {
		expect(
			flatten(buildReviewMarks([thread({ anchor: { start: 90, end: 120 } })], [], ALL, 100))
		).toHaveLength(0);
		expect(
			flatten(buildReviewMarks([], [suggestion({ anchor: { start: 120, end: 130 } })], ALL, 100))
		).toHaveLength(0);
	});

	it('draws faint resolved marks only under the Done filter', () => {
		const resolvedThread = thread({ resolvedAt: '2026-02-01' });
		const decided = suggestion({ id: 'g1', status: 'accepted' });
		// Not shown under the open filters.
		expect(flatten(buildReviewMarks([resolvedThread], [decided], ALL, 100))).toHaveLength(0);
		// Shown, faint, with no strikethrough or ghost, under Done.
		const flat = flatten(buildReviewMarks([resolvedThread], [decided], 'resolved', 100));
		expect(flat).toHaveLength(2);
		expect(flat.every((f) => f.class?.includes('rv-resolved'))).toBe(true);
		expect(flat.some((f) => f.widgetText)).toBe(false);
		expect(flat.some((f) => f.class?.includes('rv-del'))).toBe(false);
	});

	it('skips a resolved mark whose anchor was lost', () => {
		const lost = thread({ resolvedAt: '2026-02-01', anchorLost: true });
		expect(flatten(buildReviewMarks([lost], [], 'resolved', 100))).toHaveLength(0);
	});

	it('bakes the focus highlight into the matching mark only', () => {
		const flat = flatten(buildReviewMarks([thread()], [suggestion()], ALL, 100, 't1'));
		const comment = flat.find((f) => f.rid === 't1');
		const sugg = flat.find((f) => f.rid === 'g1' && f.class);
		expect(comment?.class).toContain('is-focused');
		expect(sugg?.class).not.toContain('is-focused');
	});
});
