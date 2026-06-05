import { EditorView, keymap, placeholder } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { markdownStyling, richModeExtension } from './editor-richtext';
import { formatKeymap } from './editor-format';

export type EditingMode = 'markdown' | 'rich';

// The CodeMirror base shared by every prose editor (scenes, entity bodies).
// Markdown renders styled in both modes; rich mode additionally hides the
// syntax marks away from the cursor, reading like formatted text while the
// document stays markdown.
export function proseExtensions(opts: {
	placeholder: string;
	onDocChanged: () => void;
	editingMode?: EditingMode;
}): Extension[] {
	return [
		history(),
		keymap.of([...defaultKeymap, ...historyKeymap]),
		formatKeymap(),
		markdown(),
		markdownStyling(),
		opts.editingMode === 'rich' ? richModeExtension() : [],
		placeholder(opts.placeholder),
		EditorView.lineWrapping,
		EditorView.updateListener.of((update) => {
			if (update.docChanged) opts.onDocChanged();
		})
	];
}
