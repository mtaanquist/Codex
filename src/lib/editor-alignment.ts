import {
	Decoration,
	EditorView,
	ViewPlugin,
	type DecorationSet,
	type ViewUpdate
} from '@codemirror/view';
import type { EditorState, Extension, Range } from '@codemirror/state';
import { alignmentOf } from './alignment';

// Renders \center, \right, and \justify paragraphs aligned in the editor:
// every line of such a paragraph gets a text-align line class. The marker
// itself either dims so it reads as syntax (the default), or, when the writer
// hides command markers, tucks away except on the line being edited - so the
// page reads as the finished alignment while the marker stays reachable.

export type AlignMarker = { from: number; to: number; align: string; hidden: boolean };
export type AlignLine = { from: number; align: string };
export type AlignmentPlan = { markers: AlignMarker[]; lines: AlignLine[] };

// The alignment decorations for a document: which marker spans to dim or hide,
// and which lines to align. Pure over the state, so it is testable without a
// DOM. activeLines are the lines whose markers stay visible for editing when
// hideMarkers is on.
export function alignmentPlan(
	state: EditorState,
	hideMarkers: boolean,
	activeLines: Set<number> = new Set()
): AlignmentPlan {
	const doc = state.doc;
	const markers: AlignMarker[] = [];
	const lines: AlignLine[] = [];
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
				markers.push({
					from: line.from,
					to: line.from + Math.min(found.markerLength, line.length),
					align: found.align,
					hidden: hideMarkers && !activeLines.has(n)
				});
			}
		}
		if (align) lines.push({ from: line.from, align });
	}
	return { markers, lines };
}

function compute(view: EditorView, hideMarkers: boolean): DecorationSet {
	// Only reveal a hidden marker while the editor is focused, so an idle
	// editor reads as the finished alignment.
	const reveal = hideMarkers && view.hasFocus;
	const activeLines = new Set<number>();
	if (reveal) {
		for (const range of view.state.selection.ranges) {
			const first = view.state.doc.lineAt(range.from).number;
			const last = view.state.doc.lineAt(range.to).number;
			for (let line = first; line <= last; line++) activeLines.add(line);
		}
	}
	const plan = alignmentPlan(view.state, hideMarkers, activeLines);
	const decorations: Range<Decoration>[] = [];
	for (const marker of plan.markers) {
		decorations.push(
			(marker.hidden
				? Decoration.replace({})
				: Decoration.mark({ class: 'cm-align-marker' })
			).range(marker.from, marker.to)
		);
	}
	for (const line of plan.lines) {
		decorations.push(Decoration.line({ class: `cm-align-${line.align}` }).range(line.from));
	}
	return Decoration.set(decorations, true);
}

export function alignmentExtension(hideMarkers = false): Extension {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			constructor(view: EditorView) {
				this.decorations = compute(view, hideMarkers);
			}
			update(update: ViewUpdate) {
				// Hiding reveals the marker on the active line, so the selection and
				// focus matter then; otherwise only the text does.
				if (update.docChanged || (hideMarkers && (update.selectionSet || update.focusChanged))) {
					this.decorations = compute(update.view, hideMarkers);
				}
			}
		},
		{ decorations: (value) => value.decorations }
	);
}
