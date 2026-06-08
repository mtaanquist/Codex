import { describe, it, expect } from 'vitest';
import { EditorState, EditorSelection } from '@codemirror/state';
import { paragraphBreakChange, softBreakChange } from './editor-enter';

function state(doc: string, anchor: number, head = anchor) {
	return EditorState.create({ doc, selection: EditorSelection.single(anchor, head) });
}

function applied(doc: string, anchor: number, head = anchor) {
	const initial = state(doc, anchor, head);
	const next = initial.update(paragraphBreakChange(initial)).state;
	return { text: next.doc.toString(), cursor: next.selection.main.head };
}

describe('paragraphBreakChange', () => {
	it('turns one Enter at the end of a line into a paragraph break', () => {
		const { text, cursor } = applied('Hello world', 11);
		expect(text).toBe('Hello world\n\n');
		expect(cursor).toBe(13);
	});

	it('splits a paragraph in two at the cursor', () => {
		const { text, cursor } = applied('Hello world', 6);
		expect(text).toBe('Hello \n\nworld');
		// Cursor lands at the start of the new paragraph.
		expect(cursor).toBe(8);
	});

	it('inserts only a single newline on an already-empty line', () => {
		// Cursor on the blank line between two paragraphs.
		const doc = 'One\n\nTwo';
		const { text } = applied(doc, 4);
		expect(text).toBe('One\n\n\nTwo');
	});

	it('replaces a selection with the paragraph break', () => {
		const { text, cursor } = applied('Hello cruel world', 6, 12);
		expect(text).toBe('Hello \n\nworld');
		expect(cursor).toBe(8);
	});
});

describe('softBreakChange', () => {
	it('inserts a single newline for a soft line break', () => {
		const initial = state('Hello world', 5);
		const next = initial.update(softBreakChange(initial)).state;
		expect(next.doc.toString()).toBe('Hello\n world');
		expect(next.selection.main.head).toBe(6);
	});
});
