import { StateField, Prec, type Extension } from '@codemirror/state';
import { Decoration, EditorView, keymap, ViewPlugin, type DecorationSet } from '@codemirror/view';
import type { ViewUpdate } from '@codemirror/view';
import { findTodoLines } from './todo-markers';

// TODO markers in the editor: plain "TODO:" lines get a line highlight
// straight from the text, and selection markers (rows in scene_markers)
// get a mark decoration whose position maps through edits. The mapped
// positions ride the autosave payload via the handle's anchors().

export type SceneMarker = {
	id: string;
	anchorStart: number | null;
	anchorEnd: number | null;
};

function markerField(markers: SceneMarker[]) {
	return StateField.define<DecorationSet>({
		create(state) {
			const length = state.doc.length;
			const ranges = markers
				.filter(
					(marker) =>
						marker.anchorStart !== null &&
						marker.anchorEnd !== null &&
						marker.anchorStart < marker.anchorEnd &&
						marker.anchorStart < length
				)
				.map((marker) =>
					Decoration.mark({ class: 'todo-marker', todoId: marker.id }).range(
						marker.anchorStart!,
						Math.min(marker.anchorEnd!, length)
					)
				);
			return Decoration.set(ranges, true);
		},
		update(value, tr) {
			return value.map(tr.changes);
		},
		provide: (field) => EditorView.decorations.from(field)
	});
}

const todoLine = Decoration.line({ class: 'todo-line' });

// Line highlights recomputed from the text itself; scenes are small enough
// to rescan whole.
const todoLinePlugin = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;

		constructor(view: EditorView) {
			this.decorations = this.compute(view);
		}

		update(update: ViewUpdate) {
			if (update.docChanged) this.decorations = this.compute(update.view);
		}

		compute(view: EditorView) {
			const ranges = findTodoLines(view.state.doc.toString()).map((line) =>
				todoLine.range(view.state.doc.lineAt(line.from).from)
			);
			return Decoration.set(ranges);
		}
	},
	{ decorations: (instance) => instance.decorations }
);

export type MarkerHandle = {
	extension: Extension;
	anchors(view: EditorView): { id: string; anchorStart: number; anchorEnd: number }[];
	ids: string[];
};

// One scene's marker behaviour: highlights, the text-line detector, and
// Mod-Alt-m handing the selection to onMark, which creates the row and
// refreshes the page data.
export function markerExtensions(
	markers: SceneMarker[],
	onMark: (from: number, to: number) => void
): MarkerHandle {
	const field = markerField(markers);

	const markKeymap = keymap.of([
		{
			key: 'Mod-Alt-m',
			run: (view) => {
				const { from, to } = view.state.selection.main;
				if (from === to) return false;
				onMark(from, to);
				return true;
			}
		}
	]);

	return {
		extension: [field, todoLinePlugin, Prec.high(markKeymap)],
		anchors: (view) => {
			const anchors: { id: string; anchorStart: number; anchorEnd: number }[] = [];
			const set = view.state.field(field, false);
			if (!set) return anchors;
			const cursor = set.iter();
			while (cursor.value) {
				const id = cursor.value.spec.todoId as string | undefined;
				if (id) anchors.push({ id, anchorStart: cursor.from, anchorEnd: cursor.to });
				cursor.next();
			}
			return anchors;
		},
		ids: markers.map((marker) => marker.id)
	};
}
