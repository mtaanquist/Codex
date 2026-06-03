import { EditorView, keymap, placeholder } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';

// The CodeMirror base shared by every prose editor (scenes, entity bodies).
export function proseExtensions(opts: {
	placeholder: string;
	onDocChanged: () => void;
}): Extension[] {
	return [
		history(),
		keymap.of([...defaultKeymap, ...historyKeymap]),
		markdown(),
		placeholder(opts.placeholder),
		EditorView.lineWrapping,
		EditorView.updateListener.of((update) => {
			if (update.docChanged) opts.onDocChanged();
		})
	];
}
