import { describe, it, expect } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { markdownHideRanges } from './editor-richtext';

// Rich mode hides syntax marks away from the cursor. These tests force a
// full parse headlessly and check which ranges would be hidden.
function parsed(doc: string, anchor = 0, head = anchor) {
	const state = EditorState.create({
		doc,
		selection: EditorSelection.single(anchor, head),
		extensions: [markdown()]
	});
	ensureSyntaxTree(state, state.doc.length, 5000);
	return state;
}

function hiddenText(doc: string, anchor = 0, head = anchor) {
	const state = parsed(doc, anchor, head);
	return markdownHideRanges(state).map((range) => ({
		text: doc.slice(range.from, range.to),
		bullet: range.bullet ?? false
	}));
}

describe('markdownHideRanges', () => {
	it('hides heading marks with their space, away from the cursor', () => {
		// Cursor on the second line; the heading's "## " hides.
		const doc = '## Chapter\nProse here.';
		expect(hiddenText(doc, doc.length)).toEqual([{ text: '## ', bullet: false }]);
	});

	it('hides emphasis marks around bold and italic', () => {
		const doc = 'Some **bold** and *soft* words.\nNext.';
		const hidden = hiddenText(doc, doc.length);
		expect(hidden.map((range) => range.text)).toEqual(['**', '**', '*', '*']);
	});

	it('keeps the marks visible on lines the selection touches', () => {
		const doc = '## Chapter\nSome **bold** words.';
		// Cursor inside the bold line: only the heading hides.
		expect(hiddenText(doc, doc.length - 1).map((r) => r.text)).toEqual(['## ']);
		// Cursor on the heading line: only the bold marks hide.
		expect(hiddenText(doc, 0).map((r) => r.text)).toEqual(['**', '**']);
	});

	it('marks unordered list bullets for the bullet widget', () => {
		const doc = '- One\n- Two\nElsewhere.';
		const hidden = hiddenText(doc, doc.length);
		expect(hidden).toEqual([
			{ text: '-', bullet: true },
			{ text: '-', bullet: true }
		]);
	});

	it('leaves ordered list numbers as typed', () => {
		const doc = '1. One\n2. Two\nElsewhere.';
		expect(hiddenText(doc, doc.length)).toEqual([]);
	});

	it('hides quote marks with their space', () => {
		const doc = '> A line quoted.\nElsewhere.';
		expect(hiddenText(doc, doc.length)).toEqual([{ text: '> ', bullet: false }]);
	});

	it('a multi-line selection reveals every line it touches', () => {
		const doc = '## One\n**Two**\n> Three';
		expect(hiddenText(doc, 0, doc.length)).toEqual([]);
	});

	it('an unfocused editor hides everything regardless of the cursor', () => {
		const doc = '## One\n**Two**';
		const state = parsed(doc, 0);
		const hidden = markdownHideRanges(state, undefined, false);
		expect(hidden.map((range) => doc.slice(range.from, range.to))).toEqual(['## ', '**', '**']);
	});
});
