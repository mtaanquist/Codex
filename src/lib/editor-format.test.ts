import { describe, it, expect } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import {
	setHeadingChanges,
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
