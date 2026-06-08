import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { lineBreakMarks } from './editor-nonprinting';

function marks(doc: string) {
	const state = EditorState.create({ doc });
	return lineBreakMarks(state).map((m) => ({
		kind: m.kind,
		line: state.doc.lineAt(m.pos).number
	}));
}

describe('lineBreakMarks', () => {
	it('marks a single newline between two non-blank lines as a soft wrap', () => {
		expect(marks('line one\nline two')).toEqual([{ kind: 'soft', line: 1 }]);
	});

	it('marks a blank-line break as a paragraph break on both newlines', () => {
		// "One\n\nTwo": the newline after "One" and the newline after the blank
		// line both touch the blank line, so both are paragraph breaks.
		expect(marks('One\n\nTwo')).toEqual([
			{ kind: 'paragraph', line: 1 },
			{ kind: 'paragraph', line: 2 }
		]);
	});

	it('puts no mark after the final line', () => {
		expect(marks('Only one line')).toEqual([]);
	});

	it('classifies a mix of soft and hard breaks', () => {
		// soft wrap, then a paragraph break, then a soft wrap.
		expect(marks('a\nb\n\nc\nd')).toEqual([
			{ kind: 'soft', line: 1 },
			{ kind: 'paragraph', line: 2 },
			{ kind: 'paragraph', line: 3 },
			{ kind: 'soft', line: 4 }
		]);
	});
});
