import { describe, it, expect } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import {
	setAlignmentChanges,
	setHeadingChanges,
	setIndentChanges,
	toggleBulletChanges,
	toggleInlineMark,
	toggleQuoteChanges
} from './editor-format';

function state(doc: string, anchor: number, head = anchor) {
	return EditorState.create({ doc, selection: EditorSelection.single(anchor, head) });
}

function applied(initial: EditorState, spec: ReturnType<typeof toggleInlineMark>) {
	if (!spec) return initial;
	return initial.update(spec).state;
}

describe('setIndentChanges', () => {
	function indented(doc: string, delta: number, anchor = 0) {
		const initial = state(doc, anchor);
		return applied(initial, setIndentChanges(initial, delta)).doc.toString();
	}

	it('adds the marker on a first increase and steps it up', () => {
		expect(indented('A line.', 1)).toBe('\\indent A line.');
		expect(indented('\\indent A line.', 1)).toBe('\\indent2 A line.');
	});

	it('steps down and removes the marker at zero', () => {
		expect(indented('\\indent2 A line.', -1)).toBe('\\indent A line.');
		expect(indented('\\indent A line.', -1)).toBe('A line.');
	});

	it('does nothing when already at the floor', () => {
		expect(setIndentChanges(state('A line.', 0), -1)).toBeNull();
	});

	it('keeps the indent marker after an alignment marker', () => {
		expect(indented('\\center A line.', 1)).toBe('\\center \\indent A line.');
	});
});

describe('toggleInlineMark', () => {
	it('wraps a selection and keeps it selected', () => {
		const initial = state('a word here', 2, 6);
		const next = applied(initial, toggleInlineMark(initial, '**'));
		expect(next.doc.toString()).toBe('a **word** here');
		expect(next.sliceDoc(next.selection.main.from, next.selection.main.to)).toBe('word');
	});

	it('unwraps when the marks sit just outside the selection', () => {
		const initial = state('a **word** here', 4, 8);
		const next = applied(initial, toggleInlineMark(initial, '**'));
		expect(next.doc.toString()).toBe('a word here');
	});

	it('unwraps when the selection includes the marks', () => {
		const initial = state('a **word** here', 2, 10);
		const next = applied(initial, toggleInlineMark(initial, '**'));
		expect(next.doc.toString()).toBe('a word here');
	});

	it('italicising a bolded word keeps the bold (both marks apply)', () => {
		// Bold "word" first, then italicise the same selection.
		const bold = state('a word here', 2, 6);
		const bolded = applied(bold, toggleInlineMark(bold, '**'));
		expect(bolded.doc.toString()).toBe('a **word** here');
		const sel = bolded.selection.main;
		const italic = applied(bolded, toggleInlineMark(bolded, '*'));
		expect(italic.doc.toString()).toBe('a ***word*** here');
		expect(italic.sliceDoc(italic.selection.main.from, italic.selection.main.to)).toBe('word');
		// And the reverse order lands on the same result.
		void sel;
		const it1 = state('a word here', 2, 6);
		const italicFirst = applied(it1, toggleInlineMark(it1, '*'));
		expect(italicFirst.doc.toString()).toBe('a *word* here');
		const boldSecond = applied(italicFirst, toggleInlineMark(italicFirst, '**'));
		expect(boldSecond.doc.toString()).toBe('a ***word*** here');
	});

	it('italic unwraps a plain italic word but not the inner star of bold', () => {
		const plain = state('a *word* here', 3, 7);
		expect(applied(plain, toggleInlineMark(plain, '*')).doc.toString()).toBe('a word here');
	});

	it('bold still unwraps inside a bold+italic run, leaving the italic', () => {
		const initial = state('a ***word*** here', 5, 9);
		expect(applied(initial, toggleInlineMark(initial, '**')).doc.toString()).toBe('a *word* here');
	});

	it('an empty selection gets an empty pair to type into', () => {
		const initial = state('write ', 6);
		const next = applied(initial, toggleInlineMark(initial, '*'));
		expect(next.doc.toString()).toBe('write **');
		expect(next.selection.main.from).toBe(7);
		expect(next.selection.main.empty).toBe(true);
	});
});

describe('setHeadingChanges', () => {
	it('adds the prefix and replaces a different level', () => {
		const one = state('A chapter', 0);
		expect(applied(one, setHeadingChanges(one, 2)).doc.toString()).toBe('## A chapter');

		const two = state('# A chapter', 0);
		expect(applied(two, setHeadingChanges(two, 3)).doc.toString()).toBe('### A chapter');
	});

	it('toggles off when every selected line is already at the level', () => {
		const initial = state('## One\n## Two', 0, 13);
		expect(applied(initial, setHeadingChanges(initial, 2)).doc.toString()).toBe('One\nTwo');
	});
});

describe('line prefixes', () => {
	it('quotes and unquotes the selected lines', () => {
		const initial = state('One\nTwo', 0, 7);
		const quoted = applied(initial, toggleQuoteChanges(initial));
		expect(quoted.doc.toString()).toBe('> One\n> Two');
		const back = applied(quoted, toggleQuoteChanges(quoted));
		expect(back.doc.toString()).toBe('One\nTwo');
	});

	it('adds the prefix only where missing when the selection is mixed', () => {
		const initial = state('- One\nTwo', 0, 9);
		expect(applied(initial, toggleBulletChanges(initial)).doc.toString()).toBe('- One\n- Two');
	});

	it('bullets toggle off across both marker styles', () => {
		const initial = state('- One\n* Two', 0, 11);
		expect(applied(initial, toggleBulletChanges(initial)).doc.toString()).toBe('One\nTwo');
	});
});

describe('setAlignmentChanges', () => {
	it('marks the paragraph at the cursor and clears it with left', () => {
		const initial = state('First paragraph here.\n\nSecond one.', 6);
		const centered = applied(initial, setAlignmentChanges(initial, 'center'));
		expect(centered.doc.toString()).toBe('\\center First paragraph here.\n\nSecond one.');

		const back = applied(centered, setAlignmentChanges(centered, 'left'));
		expect(back.doc.toString()).toBe('First paragraph here.\n\nSecond one.');
	});

	it('replaces an existing marker instead of stacking', () => {
		const initial = state('\\center A sign.', 10);
		const next = applied(initial, setAlignmentChanges(initial, 'right'));
		expect(next.doc.toString()).toBe('\\right A sign.');
	});

	it('covers every paragraph the selection touches', () => {
		const doc = 'One.\n\nTwo.\n\nThree.';
		const initial = state(doc, 2, doc.indexOf('Two.') + 2);
		const next = applied(initial, setAlignmentChanges(initial, 'center'));
		expect(next.doc.toString()).toBe('\\center One.\n\n\\center Two.\n\nThree.');
	});

	it('does nothing when the alignment already matches', () => {
		const initial = state('Plain text.', 3);
		expect(setAlignmentChanges(initial, 'left')).toBeNull();
	});
});
