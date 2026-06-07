import {
	Decoration,
	EditorView,
	ViewPlugin,
	type DecorationSet,
	type ViewUpdate
} from '@codemirror/view';
import type { Extension, Range } from '@codemirror/state';
import { alignmentOf } from './alignment';

// Renders \center, \right, and \justify paragraphs aligned in the editor:
// every line of such a paragraph gets a text-align line class, and the
// marker itself dims so it reads as syntax rather than prose.

function compute(view: EditorView): DecorationSet {
	const doc = view.state.doc;
	const decorations: Range<Decoration>[] = [];
	let align: string | null = null;
	let atParagraphStart = true;
	for (let n = 1; n <= doc.lines; n++) {
		const line = doc.line(n);
		if (line.text.trim() === '') {
			align = null;
			atParagraphStart = true;
			continue;
		}
		if (atParagraphStart) {
			atParagraphStart = false;
			const found = alignmentOf(line.text);
			align = found?.align ?? null;
			if (found && found.markerLength > 0) {
				decorations.push(
					Decoration.mark({ class: 'cm-align-marker' }).range(
						line.from,
						line.from + Math.min(found.markerLength, line.length)
					)
				);
			}
		}
		if (align) decorations.push(Decoration.line({ class: `cm-align-${align}` }).range(line.from));
	}
	return Decoration.set(decorations, true);
}

export function alignmentExtension(): Extension {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			constructor(view: EditorView) {
				this.decorations = compute(view);
			}
			update(update: ViewUpdate) {
				if (update.docChanged) this.decorations = compute(update.view);
			}
		},
		{ decorations: (value) => value.decorations }
	);
}
