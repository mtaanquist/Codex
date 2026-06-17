import { Decoration } from '@codemirror/view';
import type { EditorState, Extension } from '@codemirror/state';
import { alignmentOf } from './alignment';
import { indentMargin, indentOf } from './indent';
import { paragraphMarkerPlugin } from './editor-paragraph-markers';

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

export function indentExtension(hideMarkers = false): Extension {
	return paragraphMarkerPlugin(
		indentPlan,
		(line) => Decoration.line({ attributes: { style: indentMargin(line.level) } }),
		hideMarkers
	);
}
