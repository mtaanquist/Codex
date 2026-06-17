import {
	Decoration,
	EditorView,
	ViewPlugin,
	type DecorationSet,
	type ViewUpdate
} from '@codemirror/view';
import type { EditorState, Extension, Range } from '@codemirror/state';

// The shared view plugin behind the alignment and indent command markers. Both
// dim or hide a leading marker span and decorate every line of the paragraph;
// they differ only in how the plan is built and how a line is decorated. This
// owns the active-line computation (which markers stay visible for editing when
// hidden) and the recompute guard.

export type MarkerSpan = { from: number; to: number; hidden: boolean };
export type MarkerPlan<L> = { markers: MarkerSpan[]; lines: L[] };

export function paragraphMarkerPlugin<L extends { from: number }>(
	plan: (state: EditorState, hideMarkers: boolean, activeLines: Set<number>) => MarkerPlan<L>,
	lineDecoration: (line: L) => Decoration,
	hideMarkers: boolean
): Extension {
	function compute(view: EditorView): DecorationSet {
		// Only reveal a hidden marker while the editor is focused, so an idle
		// editor reads as the finished paragraph.
		const reveal = hideMarkers && view.hasFocus;
		const activeLines = new Set<number>();
		if (reveal) {
			for (const range of view.state.selection.ranges) {
				const first = view.state.doc.lineAt(range.from).number;
				const last = view.state.doc.lineAt(range.to).number;
				for (let line = first; line <= last; line++) activeLines.add(line);
			}
		}
		const { markers, lines } = plan(view.state, hideMarkers, activeLines);
		const decorations: Range<Decoration>[] = [];
		for (const marker of markers) {
			decorations.push(
				(marker.hidden
					? Decoration.replace({})
					: Decoration.mark({ class: 'cm-align-marker' })
				).range(marker.from, marker.to)
			);
		}
		for (const line of lines) {
			decorations.push(lineDecoration(line).range(line.from));
		}
		return Decoration.set(decorations, true);
	}

	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			constructor(view: EditorView) {
				this.decorations = compute(view);
			}
			update(update: ViewUpdate) {
				// Hiding reveals the marker on the active line, so the selection and
				// focus matter then; otherwise only the text does.
				if (update.docChanged || (hideMarkers && (update.selectionSet || update.focusChanged))) {
					this.decorations = compute(update.view);
				}
			}
		},
		{ decorations: (value) => value.decorations }
	);
}
