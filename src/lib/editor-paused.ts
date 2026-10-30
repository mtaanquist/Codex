import { Annotation, EditorState, type Extension } from '@codemirror/state';

// Marks an edit that must land even while paused: a finished image upload,
// whose result would otherwise be lost.
export const landsWhilePaused = Annotation.define<boolean>();

// While the page saves and replaces the open scene, the editor takes no
// edits. readOnly stops typing; the filter also stops edits dispatched
// directly (a continuation accepted with Tab, coauthor Insert).
export function pausedExtension(paused: boolean): Extension {
	return paused
		? [
				EditorState.readOnly.of(true),
				EditorState.transactionFilter.of((tr) =>
					tr.docChanged && !tr.annotation(landsWhilePaused) ? [] : tr
				)
			]
		: [];
}
