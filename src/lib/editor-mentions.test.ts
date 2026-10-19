import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { Decoration, type DecorationSet } from '@codemirror/view';
import { rescanChangedLines } from './editor-mentions';
import { detectMentions, type MentionTarget } from './mention-detect';

const targets: MentionTarget[] = [
	{ id: 'a', type: 'character', names: ['Alice Vane', 'Alice'] },
	{ id: 'h', type: 'place', names: ['Halden'] }
];

function scan(text: string, offset: number) {
	return detectMentions(text, targets, {}, offset).map((m) =>
		Decoration.mark({ attributes: { 'data-entity': m.targetId } }).range(
			m.position,
			m.position + m.length
		)
	);
}

function flatten(set: DecorationSet) {
	const out: [number, number, string][] = [];
	set.between(0, Number.MAX_SAFE_INTEGER, (from, to, value) => {
		out.push([from, to, value.spec.attributes['data-entity']]);
	});
	return out;
}

const full = (doc: string) => flatten(Decoration.set(scan(doc, 0), true));

describe('rescanChangedLines', () => {
	it('matches a full rescan after edits inside, across and between lines', () => {
		let state = EditorState.create({
			doc: 'Alice went to Halden.\nNobody here.\nHalden slept. Alice Vane woke.'
		});
		let marks = Decoration.set(scan(state.doc.toString(), 0), true);
		const edits = [
			// Extend "Alice" into "Alice Vane" on the first line.
			{ from: 5, insert: ' Vane' },
			// Add a mention on a line that had none.
			{ from: state.doc.line(1).length + 1 + 6 + 5, insert: ' Halden' },
			// Break a name on the last line.
			{ from: state.doc.length - 10, to: state.doc.length - 9 },
			// Join two lines, and delete across a mention.
			{ from: state.doc.line(1).length + 5, to: state.doc.line(1).length + 15 },
			// Several changes in one transaction.
			[
				{ from: 0, insert: 'Halden. ' },
				{ from: 10, insert: '\nAlice\n' }
			]
		];
		for (const change of edits) {
			const tr = state.update({ changes: change });
			marks = rescanChangedLines(marks, tr.changes, tr.state.doc, scan);
			state = tr.state;
			expect(flatten(marks)).toEqual(full(state.doc.toString()));
		}
	});
});
