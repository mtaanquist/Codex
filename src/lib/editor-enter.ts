import { type EditorState, type TransactionSpec, EditorSelection, Prec } from '@codemirror/state';
import { keymap, type Command, type EditorView } from '@codemirror/view';
import { insertNewlineContinueMarkup } from '@codemirror/lang-markdown';
import { completionStatus } from '@codemirror/autocomplete';

// Enter starts a new paragraph. Codex stores prose as markdown, where a
// paragraph break is a blank line and a single newline is only a soft wrap
// (it renders as a space). Writers expect one Enter to make a paragraph, so
// Enter inserts the blank line for them; Shift+Enter is the rare soft break.
// Inside a list or quote, Enter continues the markup instead.

// Replaces the selection with a paragraph break. On a line that already has
// text, that is a blank line plus the new line; on an empty line a single
// newline is enough, so repeated Enters do not pile blank lines up.
export function paragraphBreakChange(state: EditorState): TransactionSpec {
	const { from, to } = state.selection.main;
	const lineEmpty = state.doc.lineAt(from).text.trim() === '';
	const insert = lineEmpty ? '\n' : '\n\n';
	return {
		changes: { from, to, insert },
		selection: EditorSelection.cursor(from + insert.length)
	};
}

// A soft line break: a single newline within the paragraph (Shift+Enter).
export function softBreakChange(state: EditorState): TransactionSpec {
	const { from, to } = state.selection.main;
	return { changes: { from, to, insert: '\n' }, selection: EditorSelection.cursor(from + 1) };
}

function apply(view: EditorView, spec: TransactionSpec): boolean {
	view.dispatch({ ...spec, scrollIntoView: true, userEvent: 'input' });
	return true;
}

// A list item or a blockquote on the current line; there Enter should
// continue the markup (a new bullet, the next number, another quote line)
// rather than break the paragraph.
const LIST_OR_QUOTE = /^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s?)/;

export const proseEnter: Command = (view) => {
	// An open completion popup owns Enter (it accepts the selected entity);
	// defer so the autocomplete keymap handles it.
	if (completionStatus(view.state) === 'active') return false;
	const line = view.state.doc.lineAt(view.state.selection.main.head);
	if (LIST_OR_QUOTE.test(line.text) && insertNewlineContinueMarkup(view)) return true;
	return apply(view, paragraphBreakChange(view.state));
};

export const proseSoftBreak: Command = (view) => apply(view, softBreakChange(view.state));

// Higher precedence than the default keymap so Enter and Shift+Enter take the
// paragraph behaviour rather than the stock single-newline insert.
export function enterKeymap() {
	return Prec.high(
		keymap.of([
			{ key: 'Enter', run: proseEnter },
			{ key: 'Shift-Enter', run: proseSoftBreak }
		])
	);
}
