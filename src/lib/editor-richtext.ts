import {
	Decoration,
	EditorView,
	ViewPlugin,
	WidgetType,
	type DecorationSet,
	type ViewUpdate
} from '@codemirror/view';
import type { EditorState, Extension } from '@codemirror/state';
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { tags } from '@lezer/highlight';

// Markdown rendered as it reads: bold is bold, headings are big, syntax
// marks are faint. Always on, in both editing modes; the document itself
// stays plain markdown.
const markdownHighlight = HighlightStyle.define([
	{ tag: tags.strong, fontWeight: '700' },
	{ tag: tags.emphasis, fontStyle: 'italic' },
	{ tag: tags.heading1, fontSize: '1.5em', fontWeight: '650', letterSpacing: '-0.015em' },
	{ tag: tags.heading2, fontSize: '1.3em', fontWeight: '650', letterSpacing: '-0.01em' },
	{ tag: tags.heading3, fontSize: '1.15em', fontWeight: '650' },
	{ tag: tags.heading, fontWeight: '650' },
	{ tag: tags.quote, color: 'var(--text-muted)', fontStyle: 'italic' },
	{ tag: tags.monospace, fontFamily: 'var(--font-mono)', fontSize: '0.9em' },
	{ tag: tags.processingInstruction, color: 'var(--text-faint)' },
	{ tag: tags.contentSeparator, color: 'var(--text-faint)' },
	{ tag: tags.url, color: 'var(--text-faint)' },
	{ tag: tags.link, textDecoration: 'underline' }
]);

export function markdownStyling(): Extension {
	return syntaxHighlighting(markdownHighlight);
}

// The syntax marks rich mode hides while the cursor is elsewhere.
const HIDDEN_MARKS = new Set(['HeaderMark', 'EmphasisMark', 'QuoteMark', 'CodeMark']);

export type HideRange = { from: number; to: number; bullet?: boolean };

// One hidden range per syntax mark outside the selection's lines. Heading
// and quote marks swallow their following space so the text sits flush;
// bullet list marks render as a typographic bullet instead of vanishing.
// Pure over the state, so the behaviour is testable without a DOM.
export function markdownHideRanges(
	state: EditorState,
	ranges: { from: number; to: number }[] = [{ from: 0, to: state.doc.length }],
	// An unfocused editor renders fully formatted; the cursor only reveals
	// syntax while the editor actually has focus.
	revealSelection = true
): HideRange[] {
	// Lines the selection touches keep their syntax visible for editing.
	const activeLines = new Set<number>();
	if (revealSelection) {
		for (const range of state.selection.ranges) {
			const first = state.doc.lineAt(range.from).number;
			const last = state.doc.lineAt(range.to).number;
			for (let line = first; line <= last; line++) activeLines.add(line);
		}
	}

	const hidden: HideRange[] = [];
	for (const range of ranges) {
		syntaxTree(state).iterate({
			from: range.from,
			to: range.to,
			enter: (node) => {
				const isBullet = node.name === 'ListMark';
				if (!HIDDEN_MARKS.has(node.name) && !isBullet) return;
				if (activeLines.has(state.doc.lineAt(node.from).number)) return;
				if (isBullet) {
					// Only unordered marks become bullets; numbers stay as typed.
					if (!/^[-*+]$/.test(state.sliceDoc(node.from, node.to))) return;
					hidden.push({ from: node.from, to: node.to, bullet: true });
					return;
				}
				// "# " and "> " disappear with their separator space.
				let to = node.to;
				if (
					(node.name === 'HeaderMark' || node.name === 'QuoteMark') &&
					state.sliceDoc(to, to + 1) === ' '
				) {
					to += 1;
				}
				hidden.push({ from: node.from, to });
			}
		});
	}
	return hidden;
}

class BulletWidget extends WidgetType {
	toDOM(): HTMLElement {
		const span = document.createElement('span');
		span.className = 'cm-rich-bullet';
		span.textContent = '•';
		return span;
	}
}

const bullet = new BulletWidget();

function compute(view: EditorView): DecorationSet {
	const decorations = markdownHideRanges(view.state, view.visibleRanges.slice(), view.hasFocus).map(
		(range) =>
			range.bullet
				? Decoration.replace({ widget: bullet }).range(range.from, range.to)
				: Decoration.replace({}).range(range.from, range.to)
	);
	return Decoration.set(decorations, true);
}

// Rich editing mode: live-preview markdown. The styling above stays; this
// hides the syntax marks except on the lines being edited, so the page
// reads like formatted text while remaining markdown underneath.
export function richModeExtension(): Extension {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			constructor(view: EditorView) {
				this.decorations = compute(view);
			}
			update(update: ViewUpdate) {
				if (
					update.docChanged ||
					update.selectionSet ||
					update.viewportChanged ||
					update.focusChanged
				) {
					this.decorations = compute(update.view);
				}
			}
		},
		{ decorations: (value) => value.decorations }
	);
}
