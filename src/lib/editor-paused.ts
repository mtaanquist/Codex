import { EditorState, type Extension } from '@codemirror/state';

// While the page saves and replaces the open scene, the editor takes no
// edits. readOnly stops typing; the filter also stops edits dispatched
// directly (a continuation accepted with Tab, a finished image upload).
export function pausedExtension(paused: boolean): Extension {
	return paused
		? [
				EditorState.readOnly.of(true),
				EditorState.transactionFilter.of((tr) => (tr.docChanged ? [] : tr))
			]
		: [];
}
