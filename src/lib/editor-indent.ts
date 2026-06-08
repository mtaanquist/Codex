import {
	Decoration,
	EditorView,
	ViewPlugin,
	type DecorationSet,
	type ViewUpdate
} from '@codemirror/view';
import type { EditorState, Extension, Range } from '@codemirror/state';
import { alignmentOf } from './alignment';
import { indentMargin, indentOf } from './indent';

// Renders \indent paragraphs shifted right in the editor: every line of such a
// paragraph gets an inline left margin. The marker itself dims, or - when the
// writer hides command markers - tucks away except on the line being edited.
// It sits after any alignment marker, so an aligned paragraph can also indent.

export type IndentMarkerSpan = { from: number; to: number; hidden: boolean };
export type IndentLine = { from: number; level: number };
export type IndentPlan = { markers: IndentMarkerSpan[]; lines: IndentLine[] };

// Pure over the state, so it is testable without a DOM. activeLines are the
// lines whose markers stay visible for editing when hideMarkers is on.
export function indentPlan(
	state: EditorState,
	hideMarkers: boolean,
	activeLines: Set<number> = new Set()
): IndentPlan {
	const doc = state.doc;
	const markers: IndentMarkerSpan[] = [];
	const lines: IndentLine[] = [];
	let level: number | null = null;
	let atParagraphStart = true;
	for (let n = 1; n <= doc.lines; n++) {
		const line = doc.line(n);
		if (line.text.trim() === '') {
			level = null;
			atParagraphStart = true;
			continue;
		}
		if (atParagraphStart) {
			atParagraphStart = false;
			const offset = alignmentOf(line.text)?.markerLength ?? 0;
			const found = indentOf(line.text.slice(offset));
			level = found?.level ?? null;
			if (found) {
				const from = line.from + offset;
				markers.push({
					from,
					to: from + Math.min(found.markerLength, line.length - offset),
					hidden: hideMarkers && !activeLines.has(n)
				});
			}
		}
		if (level) lines.push({ from: line.from, level });
	}
	return { markers, lines };
}

function compute(view: EditorView, hideMarkers: boolean): DecorationSet {
	const reveal = hideMarkers && view.hasFocus;
	const activeLines = new Set<number>();
	if (reveal) {
		for (const range of view.state.selection.ranges) {
			const first = view.state.doc.lineAt(range.from).number;
			const last = view.state.doc.lineAt(range.to).number;
			for (let line = first; line <= last; line++) activeLines.add(line);
		}
	}
	const plan = indentPlan(view.state, hideMarkers, activeLines);
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
		decorations.push(
			Decoration.line({ attributes: { style: indentMargin(line.level) } }).range(line.from)
		);
	}
	return Decoration.set(decorations, true);
}

export function indentExtension(hideMarkers = false): Extension {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			constructor(view: EditorView) {
				this.decorations = compute(view, hideMarkers);
			}
			update(update: ViewUpdate) {
				if (update.docChanged || (hideMarkers && (update.selectionSet || update.focusChanged))) {
					this.decorations = compute(update.view, hideMarkers);
				}
			}
		},
		{ decorations: (value) => value.decorations }
	);
}
