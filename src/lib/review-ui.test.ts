import { describe, it, expect } from 'vitest';
import {
	nudgeMarkers,
	authorColor,
	appAuthorParts,
	authorInitials,
	avatarInitials,
	authorKey,
	roleLabel,
	reviewMarks,
	reviewProse,
	suggestionKind,
	suggestionSnippet,
	suggestionInFilter,
	threadInFilter,
	isWholeSceneNote,
	patternName,
	patternEdits,
	patternQueue,
	pendingPatternCounts,
	type MarkSuggestion,
	type MarkThread,
	type ReviewSuggestion,
	type ReviewThread
} from './review-ui';

const OWNER = { isOwner: true, isAssistant: false, name: 'Mara' };
const ASSISTANT = { isOwner: false, isAssistant: true, name: 'Codex' };
const GUEST = { isOwner: false, isAssistant: false, name: 'Jo Reeve' };

const BASE = 'The quick brown fox jumps over the lazy dog.';
const FOX = BASE.indexOf('brown'); // 10
const FOX_END = FOX + 'brown fox'.length; // 19

function comment(id: string, start: number, end: number, author = GUEST): MarkThread {
	return { id, anchor: { start, end }, author };
}
function suggestion(
	id: string,
	start: number,
	end: number,
	original: string,
	replacement: string,
	extra: Partial<MarkSuggestion> = {}
): MarkSuggestion {
	return {
		id,
		anchor: { start, end },
		status: 'pending',
		original,
		replacement,
		author: GUEST,
		...extra
	};
}

describe('authorColor / authorKey / authorInitials', () => {
	it('gives the owner the accent and the assistant a fixed tint', () => {
		expect(authorColor(OWNER)).toBe('var(--accent)');
		expect(authorColor(ASSISTANT)).toBe('var(--cat-violet)');
		expect(authorKey(OWNER)).toBe('owner');
		expect(authorKey(ASSISTANT)).toBe('assistant');
	});

	it('colours a guest deterministically from their name', () => {
		expect(authorColor(GUEST)).toBe(authorColor({ ...GUEST }));
		expect(authorColor(GUEST)).toMatch(/^var\(--cat-/);
		expect(authorKey(GUEST)).toBe('reviewer:Jo Reeve');
	});

	it('tells an outside app from a guest of the same name', () => {
		const app = { isOwner: false, isAssistant: false, isApp: true, name: 'Jo Reeve' };
		expect(authorKey(app)).toBe('app:Jo Reeve');
		expect(roleLabel(app)).toBe('App');
		expect(roleLabel(GUEST)).toBe('Reviewer');
	});

	it('builds one or two initials', () => {
		expect(authorInitials('Jo Reeve')).toBe('JR');
		expect(authorInitials('Mara')).toBe('MA');
		expect(authorInitials('   ')).toBe('?');
	});

	it('names an app by its own name, with the host apart', () => {
		expect(appAuthorParts('Writing Desk (app.example)')).toEqual({
			name: 'Writing Desk',
			host: 'app.example'
		});
		expect(appAuthorParts('My script (personal token)')).toEqual({
			name: 'My script',
			host: 'personal token'
		});
		// A name with brackets of its own keeps them.
		expect(appAuthorParts('Desk (beta) (app.example)')).toEqual({
			name: 'Desk (beta)',
			host: 'app.example'
		});
		// An app with no name of its own is shown by its host alone.
		expect(appAuthorParts('app.example')).toEqual({ name: 'app.example', host: null });
	});

	it('takes an apps initials from its name, not its host', () => {
		const app = (name: string) => ({ isOwner: false, isAssistant: false, isApp: true, name });
		expect(avatarInitials(app('Writing Desk (app.example)'))).toBe('WD');
		expect(avatarInitials(app('W (app.example)'))).toBe('W');
		expect(avatarInitials(app('Claude (claude.ai)'))).toBe('CL');
		expect(avatarInitials({ isOwner: false, isAssistant: false, name: 'Jo (Reeve)' })).toBe('J(');
	});
});

describe('suggestionKind', () => {
	it('reads insert, delete, and replace from the text', () => {
		expect(suggestionKind({ original: '', replacement: 'new' })).toBe('insert');
		expect(suggestionKind({ original: 'old', replacement: '' })).toBe('delete');
		expect(suggestionKind({ original: 'old', replacement: 'new' })).toBe('replace');
	});
});

describe('reviewMarks', () => {
	it('returns the whole text as one plain run with no notes', () => {
		expect(reviewMarks(BASE, [], [], 'all')).toEqual([{ kind: 'plain', text: BASE }]);
	});

	it('wraps a comment anchor and keeps the surrounding text', () => {
		const marks = reviewMarks(BASE, [comment('t1', FOX, FOX_END)], [], 'all');
		expect(marks).toEqual([
			{ kind: 'plain', text: 'The quick ' },
			{ kind: 'comment', text: 'brown fox', id: 't1', color: authorColor(GUEST) },
			{ kind: 'plain', text: ' jumps over the lazy dog.' }
		]);
		// Concatenating the runs reproduces the text exactly.
		expect(marks.map((m) => ('text' in m ? m.text : '')).join('')).toBe(BASE);
	});

	it('renders a replace as before+after and a delete as struck text', () => {
		const replace = reviewMarks(
			BASE,
			[],
			[suggestion('s1', FOX, FOX_END, 'brown fox', 'red hen')],
			'all'
		);
		expect(replace.find((m) => m.kind === 'replace')).toEqual({
			kind: 'replace',
			before: 'brown fox',
			after: 'red hen',
			id: 's1',
			color: authorColor(GUEST)
		});

		const del = reviewMarks(BASE, [], [suggestion('s2', FOX, FOX_END, 'brown fox', '')], 'all');
		expect(del.find((m) => m.kind === 'del')).toMatchObject({ kind: 'del', text: 'brown fox' });
	});

	it('inserts replacement text at a point without consuming the body', () => {
		const at = BASE.indexOf('fox') + 3; // after "fox"
		const marks = reviewMarks(BASE, [], [suggestion('s3', at, at, '', ' (a vixen)')], 'all');
		const ins = marks.find((m) => m.kind === 'ins');
		expect(ins).toMatchObject({ kind: 'ins', text: ' (a vixen)' });
		// The plain runs still spell out the original text.
		expect(
			marks
				.filter((m) => m.kind === 'plain')
				.map((m) => (m as { text: string }).text)
				.join('')
		).toBe(BASE);
	});

	it('keeps the first of two overlapping anchors and skips the rest', () => {
		const marks = reviewMarks(
			BASE,
			[comment('a', FOX, FOX_END), comment('b', FOX + 2, FOX_END + 5)],
			[],
			'all'
		);
		const ids = marks.filter((m) => m.kind === 'comment').map((m) => (m as { id: string }).id);
		expect(ids).toEqual(['a']);
	});

	it('hides suggestions when filtering to comments and vice versa', () => {
		const threads = [comment('t1', FOX, FOX_END)];
		const suggs = [suggestion('s1', 0, 3, 'The', 'A')];
		expect(reviewMarks(BASE, threads, suggs, 'comments').some((m) => m.kind === 'comment')).toBe(
			true
		);
		expect(reviewMarks(BASE, threads, suggs, 'comments').some((m) => m.kind === 'replace')).toBe(
			false
		);
		expect(reviewMarks(BASE, threads, suggs, 'suggestions').some((m) => m.kind === 'comment')).toBe(
			false
		);
		expect(reviewMarks(BASE, threads, suggs, 'suggestions').some((m) => m.kind === 'replace')).toBe(
			true
		);
	});

	it('drops a comment whose anchor was lost', () => {
		const marks = reviewMarks(BASE, [{ id: 't1', anchor: null, author: GUEST }], [], 'all');
		expect(marks).toEqual([{ kind: 'plain', text: BASE }]);
	});
});

describe('reviewProse', () => {
	// "brown" = [10, 15), "fox" = [16, 19) in BASE.
	const brown = { position: 10, length: 5, targetId: 'e-brown' };
	const fox = { position: 16, length: 3, targetId: 'e-fox' };

	it('highlights mentions in plain text and keeps the text whole', () => {
		const runs = reviewProse(BASE, [], [], 'all', [brown, fox]);
		expect(
			runs.filter((r) => r.kind === 'mention').map((r) => (r as { text: string }).text)
		).toEqual(['brown', 'fox']);
		expect(runs.map((r) => ('text' in r ? r.text : '')).join('')).toBe(BASE);
	});

	it('drops a mention that falls inside a comment mark', () => {
		// Comment on "brown fox" [10,19); the mentions sit inside it.
		const runs = reviewProse(BASE, [comment('t1', 10, 19)], [], 'all', [brown, fox]);
		expect(runs.some((r) => r.kind === 'mention')).toBe(false);
		expect(runs.some((r) => r.kind === 'comment')).toBe(true);
		expect(
			runs.map((r) => ('text' in r ? r.text : 'before' in r ? r.before : '')).join('')
		).toContain('brown fox');
	});

	it('keeps a mention that sits beside a mark', () => {
		// Comment on "The" [0,3); "brown"/"fox" mentions remain highlighted.
		const runs = reviewProse(BASE, [comment('t1', 0, 3)], [], 'all', [brown, fox]);
		expect(runs.filter((r) => r.kind === 'mention')).toHaveLength(2);
		expect(runs.filter((r) => r.kind === 'comment')).toHaveLength(1);
	});
});

describe('threadInFilter / suggestionInFilter', () => {
	const open = { resolvedAt: null };
	const done = { resolvedAt: new Date() };
	it('routes open threads to all/comments and resolved ones to resolved', () => {
		expect(threadInFilter(open, 'all')).toBe(true);
		expect(threadInFilter(open, 'comments')).toBe(true);
		expect(threadInFilter(open, 'suggestions')).toBe(false);
		expect(threadInFilter(open, 'resolved')).toBe(false);
		expect(threadInFilter(done, 'resolved')).toBe(true);
		expect(threadInFilter(done, 'all')).toBe(false);
	});
	it('routes pending suggestions to all/suggestions and decided ones to resolved', () => {
		expect(suggestionInFilter({ status: 'pending' }, 'all')).toBe(true);
		expect(suggestionInFilter({ status: 'pending' }, 'suggestions')).toBe(true);
		expect(suggestionInFilter({ status: 'pending' }, 'comments')).toBe(false);
		expect(suggestionInFilter({ status: 'accepted' }, 'resolved')).toBe(true);
		expect(suggestionInFilter({ status: 'rejected' }, 'resolved')).toBe(true);
		expect(suggestionInFilter({ status: 'pending' }, 'resolved')).toBe(false);
	});
});

describe('suggestionSnippet', () => {
	it('summarises each kind of edit', () => {
		expect(suggestionSnippet({ original: '', replacement: 'a vixen' })).toBe('Insert "a vixen"');
		expect(suggestionSnippet({ original: 'brown fox', replacement: '' })).toBe(
			'Delete "brown fox"'
		);
		expect(suggestionSnippet({ original: 'brown fox', replacement: 'red hen' })).toBe(
			'"brown fox" to "red hen"'
		);
	});
});

describe('nudgeMarkers', () => {
	it('spreads stacked markers and keeps separated ones in place', () => {
		const nudged = nudgeMarkers([{ top: 100 }, { top: 10 }, { top: 12 }, { top: 30 }]);
		expect(nudged.map((m) => m.top)).toEqual([10, 42, 74, 106]);
	});

	it('leaves well-separated markers untouched', () => {
		expect(nudgeMarkers([{ top: 0 }, { top: 50 }]).map((m) => m.top)).toEqual([0, 50]);
	});
});

describe('isWholeSceneNote', () => {
	const thread = (id: string, anchor: { start: number; end: number } | null) =>
		({ id, anchor }) as ReviewThread;
	const suggestion = (id: string, anchor: { start: number; end: number } | null) =>
		({ id, anchor }) as ReviewSuggestion;

	it('is true for an anchorless thread or suggestion', () => {
		expect(isWholeSceneNote('t1', [thread('t1', null)], [])).toBe(true);
		expect(isWholeSceneNote('s1', [], [suggestion('s1', null)])).toBe(true);
	});

	it('is false when the matching note has an anchor', () => {
		expect(isWholeSceneNote('t1', [thread('t1', { start: 0, end: 3 })], [])).toBe(false);
	});

	it('is false when no note matches the id', () => {
		expect(isWholeSceneNote('x', [thread('t1', null)], [suggestion('s1', null)])).toBe(false);
	});
});

describe('the guided pass over a pattern note', () => {
	const edit = (
		id: string,
		sceneId: string,
		start: number | null,
		over: Partial<{
			patternThreadId: string | null;
			status: string;
			followsId: string | null;
			createdAt: string;
		}> = {}
	) => ({
		id,
		sceneId,
		patternThreadId: 'note',
		followsId: null as string | null,
		createdAt: '2026-11-20T10:00:00Z',
		status: 'pending',
		anchor: start === null ? null : { start, end: start + 1 },
		...over
	});

	it('counts the pending edits of each note', () => {
		const counts = pendingPatternCounts([
			edit('a', 's1', 1),
			edit('b', 's1', 2),
			edit('c', 's1', 3, { status: 'accepted' }),
			edit('d', 's1', 4, { patternThreadId: 'other' }),
			edit('e', 's1', 5, { patternThreadId: null })
		]);
		expect(counts.get('note')).toBe(2);
		expect(counts.get('other')).toBe(1);
		expect(counts.size).toBe(2);
	});

	it('orders the queue by scene, then by position, lost anchors and unknown scenes last', () => {
		const queue = patternQueue(
			[
				edit('late', 's2', 40),
				edit('lost', 's1', null),
				edit('early', 's2', 3),
				edit('first', 's1', 10),
				edit('trashed', 'gone', 0),
				edit('decided', 's1', 0, { status: 'rejected' }),
				edit('elsewhere', 's1', 1, { patternThreadId: 'other' })
			],
			'note',
			['s1', 's2']
		);
		expect(queue.map((s) => s.id)).toEqual(['first', 'lost', 'early', 'late', 'trashed']);
	});

	it('lists every edit of the note, decided ones in their reading place', () => {
		const edits = patternEdits(
			[
				edit('late', 's2', 40),
				edit('accepted', 's1', 20, { status: 'accepted' }),
				edit('first', 's1', 10),
				edit('rejected', 's2', 1, { status: 'rejected' }),
				edit('elsewhere', 's1', 1, { patternThreadId: 'other' })
			],
			'note',
			['s1', 's2']
		);
		expect(edits.map((s) => s.id)).toEqual(['first', 'accepted', 'rejected', 'late']);
	});

	it("puts follow-ups after the note's own edits, oldest first", () => {
		const queue = patternQueue(
			[
				edit('newer', 's1', 0, { followsId: 'a', createdAt: '2026-11-20T10:02:00Z' }),
				edit('late', 's2', 40),
				edit('older', 's2', 99, { followsId: 'b', createdAt: '2026-11-20T10:01:00Z' }),
				edit('first', 's1', 10)
			],
			'note',
			['s1', 's2']
		);
		expect(queue.map((s) => s.id)).toEqual(['first', 'late', 'older', 'newer']);
	});

	it('names the pattern from its label, or from the first line', () => {
		expect(patternName('Pattern note (POV epithets): Kara is often called the elf.')).toBe(
			'POV epithets'
		);
		expect(patternName('The narration leans on "seemed".\nMore here.')).toBe(
			'The narration leans on "seemed".'
		);
		expect(patternName('x'.repeat(80))).toBe(`${'x'.repeat(60)}...`);
	});
});
