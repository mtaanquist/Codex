import { EditorSelection, type EditorState, type TransactionSpec } from '@codemirror/state';
import { keymap, type Command, type EditorView } from '@codemirror/view';

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
	if (before === mark && after === mark) {
		return {
			changes: [
				{ from: from - len, to: from },
				{ from: to, to: to + len }
			],
			selection: EditorSelection.range(from - len, to - len)
		};
	}
	if (to - from >= 2 * len && state.sliceDoc(from, from + len) === mark) {
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

export function formatKeymap() {
	return keymap.of([
		{ key: 'Mod-b', run: toggleBold },
		{ key: 'Mod-i', run: toggleItalic }
	]);
}
