import {
	Decoration,
	EditorView,
	ViewPlugin,
	WidgetType,
	highlightWhitespace,
	type DecorationSet,
	type ViewUpdate
} from '@codemirror/view';
import type { EditorState, Extension, Range } from '@codemirror/state';

// Shows the non-printing characters: spaces as a middot (the built-in
// whitespace highlighter), and the line breaks as glyphs at the end of each
// line. A break between two non-blank lines is a soft wrap (it renders as a
// space), shown as a return arrow; any break touching a blank line is a real
// paragraph break, shown as a pilcrow. Seeing the difference is the point:
// it is exactly what makes a single newline behave unlike a paragraph.

export type LineBreakMark = { pos: number; kind: 'paragraph' | 'soft' };

function blank(text: string): boolean {
	return text.trim() === '';
}

// One mark per newline in the given ranges, classifying it as a paragraph
// break or a soft wrap. Pure over the state, so it is testable without a DOM.
export function lineBreakMarks(
	state: EditorState,
	ranges: { from: number; to: number }[] = [{ from: 0, to: state.doc.length }]
): LineBreakMark[] {
	const doc = state.doc;
	const marks: LineBreakMark[] = [];
	const seen = new Set<number>();
	for (const range of ranges) {
		const first = doc.lineAt(range.from).number;
		const last = doc.lineAt(range.to).number;
		for (let n = first; n <= last; n++) {
			// The last line has no newline after it, so nothing to mark.
			if (n >= doc.lines || seen.has(n)) continue;
			seen.add(n);
			const here = doc.line(n);
			const next = doc.line(n + 1);
			const soft = !blank(here.text) && !blank(next.text);
			marks.push({ pos: here.to, kind: soft ? 'soft' : 'paragraph' });
		}
	}
	return marks;
}

class GlyphWidget extends WidgetType {
	constructor(private readonly kind: 'paragraph' | 'soft') {
		super();
	}
	eq(other: GlyphWidget): boolean {
		return other.kind === this.kind;
	}
	toDOM(): HTMLElement {
		const span = document.createElement('span');
		span.className = this.kind === 'soft' ? 'cm-np-soft' : 'cm-np-para';
		span.textContent = this.kind === 'soft' ? '↵' : '¶';
		return span;
	}
	get estimatedHeight(): number {
		return -1;
	}
	ignoreEvent(): boolean {
		return false;
	}
}

const paragraphGlyph = new GlyphWidget('paragraph');
const softGlyph = new GlyphWidget('soft');

function compute(view: EditorView): DecorationSet {
	const decorations: Range<Decoration>[] = lineBreakMarks(
		view.state,
		view.visibleRanges.slice()
	).map((mark) =>
		Decoration.widget({
			widget: mark.kind === 'soft' ? softGlyph : paragraphGlyph,
			side: 1
		}).range(mark.pos)
	);
	return Decoration.set(decorations, true);
}

const lineBreakGlyphs = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;
		constructor(view: EditorView) {
			this.decorations = compute(view);
		}
		update(update: ViewUpdate) {
			if (update.docChanged || update.viewportChanged) {
				this.decorations = compute(update.view);
			}
		}
	},
	{ decorations: (value) => value.decorations }
);

// Spaces and tabs via the built-in highlighter, plus the line-break glyphs.
export function nonPrintingExtension(): Extension {
	return [highlightWhitespace(), lineBreakGlyphs];
}
