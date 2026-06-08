import { EditorSelection, type EditorState, type TransactionSpec } from '@codemirror/state';
import { keymap, type Command, type EditorView } from '@codemirror/view';
import { alignmentMarker, alignmentOf, type Alignment } from './alignment';
import { indentMarker, indentOf, MAX_INDENT } from './indent';

// Markdown formatting commands behind the toolbar and the Mod-B/Mod-I
// shortcuts. Each builds its changes in a pure function over the state, so
// the behaviour is unit-testable without a DOM; the commands wrap them.

// Toggles an inline mark (** or *) around the main selection. A selection
// already wrapped - marks just outside it, or included in it - unwraps;
// anything else wraps. An empty selection gets an empty pair to type into.
export function toggleInlineMark(state: EditorState, mark: string): TransactionSpec | null {
	const { from, to } = state.selection.main;
	const len = mark.length;
	const before = state.sliceDoc(Math.max(0, from - len), from);
	const after = state.sliceDoc(to, Math.min(state.doc.length, to + len));
	// A single * next to the selection might be the inner star of a ** (bold),
	// not an italic mark of its own. Toggling italic must not eat it, or bolding
	// then italicising a word would strip the bold. So an italic mark (len 1)
	// only unwraps when its star is isolated - no further star just beyond it.
	// Bold (len 2) needs no such guard: a ** beside an extra star is a complete
	// bold mark in a *** run, and unwrapping it correctly leaves the italic.
	const ch = mark[0];
	const isolatedBefore =
		len > 1 || state.sliceDoc(Math.max(0, from - len - 1), Math.max(0, from - len)) !== ch;
	const isolatedAfter =
		len > 1 ||
		state.sliceDoc(
			Math.min(state.doc.length, to + len),
			Math.min(state.doc.length, to + len + 1)
		) !== ch;
	if (before === mark && after === mark && isolatedBefore && isolatedAfter) {
		return {
			changes: [
				{ from: from - len, to: from },
				{ from: to, to: to + len }
			],
			selection: EditorSelection.range(from - len, to - len)
		};
	}
	const insideIsolatedBefore = len > 1 || state.sliceDoc(Math.max(0, from - 1), from) !== ch;
	const insideIsolatedAfter =
		len > 1 || state.sliceDoc(to, Math.min(state.doc.length, to + 1)) !== ch;
	if (
		to - from >= 2 * len &&
		insideIsolatedBefore &&
		insideIsolatedAfter &&
		state.sliceDoc(from, from + len) === mark
	) {
		if (state.sliceDoc(to - len, to) === mark) {
			return {
				changes: [
					{ from, to: from + len },
					{ from: to - len, to }
				],
				selection: EditorSelection.range(from, to - 2 * len)
			};
		}
	}
	return {
		changes: [
			{ from, insert: mark },
			{ from: to, insert: mark }
		],
		selection: EditorSelection.range(from + len, to + len)
	};
}

// Rewrites every line the main selection touches. Returns null when no
// line changes.
function mapSelectedLines(
	state: EditorState,
	transform: (text: string) => string
): TransactionSpec | null {
	const { from, to } = state.selection.main;
	const changes: { from: number; to: number; insert: string }[] = [];
	const first = state.doc.lineAt(from).number;
	const last = state.doc.lineAt(to).number;
	for (let number = first; number <= last; number++) {
		const line = state.doc.line(number);
		const next = transform(line.text);
		if (next !== line.text) changes.push({ from: line.from, to: line.to, insert: next });
	}
	return changes.length > 0 ? { changes } : null;
}

const HEADING = /^#{1,6}\s+/;

// Sets the selected lines to the given heading level; if every line is
// already at that level, removes the heading instead (a toggle).
export function setHeadingChanges(state: EditorState, level: 1 | 2 | 3): TransactionSpec | null {
	const prefix = '#'.repeat(level) + ' ';
	const { from, to } = state.selection.main;
	const first = state.doc.lineAt(from).number;
	const last = state.doc.lineAt(to).number;
	let allAtLevel = true;
	for (let number = first; number <= last; number++) {
		if (!state.doc.line(number).text.startsWith(prefix)) allAtLevel = false;
	}
	return mapSelectedLines(state, (text) =>
		allAtLevel ? text.slice(prefix.length) : prefix + text.replace(HEADING, '')
	);
}

// Adds or removes a line prefix (quote, bullet) across the selection: if
// every selected line already carries it, it comes off; a mixed selection
// gets the prefix added where it is missing.
function toggleLinePrefix(
	state: EditorState,
	matcher: RegExp,
	prefix: string
): TransactionSpec | null {
	const { from, to } = state.selection.main;
	const first = state.doc.lineAt(from).number;
	const last = state.doc.lineAt(to).number;
	let allPrefixed = true;
	for (let number = first; number <= last; number++) {
		if (!matcher.test(state.doc.line(number).text)) allPrefixed = false;
	}
	return mapSelectedLines(state, (text) => {
		if (allPrefixed) return text.replace(matcher, '');
		return matcher.test(text) ? text : prefix + text;
	});
}

export function toggleQuoteChanges(state: EditorState): TransactionSpec | null {
	return toggleLinePrefix(state, /^>\s?/, '> ');
}

export function toggleBulletChanges(state: EditorState): TransactionSpec | null {
	return toggleLinePrefix(state, /^[-*]\s+/, '- ');
}

// Sets the alignment of every paragraph the selection touches by writing
// (or clearing, for left) the \center / \right / \justify marker at each
// paragraph's start. A paragraph is the lines between blank lines.
export function setAlignmentChanges(state: EditorState, align: Alignment): TransactionSpec | null {
	const doc = state.doc;
	const range = state.selection.main;
	const marker = alignmentMarker(align);

	// Walk back from the selection to the start of its first paragraph.
	let n = doc.lineAt(range.from).number;
	while (n > 1 && doc.line(n).text.trim() !== '' && doc.line(n - 1).text.trim() !== '') n--;

	const lastSelected = doc.lineAt(range.to).number;
	const changes: { from: number; to: number; insert: string }[] = [];
	let atParagraphStart = true;
	for (; n <= doc.lines && n <= lastSelected; n++) {
		const line = doc.line(n);
		if (line.text.trim() === '') {
			atParagraphStart = true;
			continue;
		}
		if (!atParagraphStart) continue;
		atParagraphStart = false;
		const found = alignmentOf(line.text);
		const current = found?.align ?? 'left';
		if (current === align) continue;
		changes.push({ from: line.from, to: line.from + (found?.markerLength ?? 0), insert: marker });
	}
	if (changes.length === 0) return null;
	return { changes };
}

// Steps the block indent of every paragraph the selection touches up or down
// by one level (delta +1 or -1), clamped to 0..MAX_INDENT. The indent marker
// sits after any alignment marker, so an aligned paragraph indents too.
export function setIndentChanges(state: EditorState, delta: number): TransactionSpec | null {
	const doc = state.doc;
	const range = state.selection.main;
	let n = doc.lineAt(range.from).number;
	while (n > 1 && doc.line(n).text.trim() !== '' && doc.line(n - 1).text.trim() !== '') n--;
	const lastSelected = doc.lineAt(range.to).number;
	const changes: { from: number; to: number; insert: string }[] = [];
	let atParagraphStart = true;
	for (; n <= doc.lines && n <= lastSelected; n++) {
		const line = doc.line(n);
		if (line.text.trim() === '') {
			atParagraphStart = true;
			continue;
		}
		if (!atParagraphStart) continue;
		atParagraphStart = false;
		const offset = alignmentOf(line.text)?.markerLength ?? 0;
		const found = indentOf(line.text.slice(offset));
		const current = found?.level ?? 0;
		const next = Math.min(Math.max(current + delta, 0), MAX_INDENT);
		if (next === current) continue;
		const from = line.from + offset;
		changes.push({ from, to: from + (found?.markerLength ?? 0), insert: indentMarker(next) });
	}
	if (changes.length === 0) return null;
	return { changes };
}

function apply(view: EditorView, spec: TransactionSpec | null): boolean {
	if (!spec) return false;
	view.dispatch({ ...spec, scrollIntoView: true, userEvent: 'input.format' });
	return true;
}

export const toggleBold: Command = (view) => apply(view, toggleInlineMark(view.state, '**'));
export const toggleItalic: Command = (view) => apply(view, toggleInlineMark(view.state, '*'));
export const setHeading =
	(level: 1 | 2 | 3): Command =>
	(view) =>
		apply(view, setHeadingChanges(view.state, level));
export const toggleQuote: Command = (view) => apply(view, toggleQuoteChanges(view.state));
export const toggleBulletList: Command = (view) => apply(view, toggleBulletChanges(view.state));
export const setAlignment =
	(align: Alignment): Command =>
	(view) =>
		apply(view, setAlignmentChanges(view.state, align));
export const increaseIndent: Command = (view) => apply(view, setIndentChanges(view.state, 1));
export const decreaseIndent: Command = (view) => apply(view, setIndentChanges(view.state, -1));

export function formatKeymap() {
	return keymap.of([
		{ key: 'Mod-b', run: toggleBold },
		{ key: 'Mod-i', run: toggleItalic },
		// Bracket keys step the indent, matching common editors.
		{ key: 'Mod-]', run: increaseIndent },
		{ key: 'Mod-[', run: decreaseIndent }
	]);
}
