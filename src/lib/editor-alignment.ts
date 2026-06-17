import { Decoration } from '@codemirror/view';
import type { EditorState, Extension } from '@codemirror/state';
import { alignmentOf } from './alignment';
import { paragraphMarkerPlugin } from './editor-paragraph-markers';

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

export function alignmentExtension(hideMarkers = false): Extension {
	return paragraphMarkerPlugin(
		alignmentPlan,
		(line) => Decoration.line({ class: `cm-align-${line.align}` }),
		hideMarkers
	);
}
