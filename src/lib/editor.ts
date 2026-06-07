import { EditorView, keymap, placeholder } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { search, searchKeymap } from '@codemirror/search';
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
	// Plain prose: no markdown styling and no formatting shortcuts; entity
	// descriptions use it. The text still stores (and exports) as markdown,
	// it just is not treated as markdown while editing.
	plain?: boolean;
	// Browser-native spell-check; the language tag picks the dictionary,
	// blank follows the browser. CodeMirror turns spellcheck off by
	// default, so this opts back in.
	spellCheck?: { enabled: boolean; language: string };
}): Extension[] {
	return [
		history(),
		keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
		opts.plain ? [] : formatKeymap(),
		// Find and replace within the scene; Ctrl+F opens the panel.
		search(),
		opts.plain ? [] : [markdown(), markdownStyling()],
		!opts.plain && opts.editingMode === 'rich' ? richModeExtension() : [],
		opts.spellCheck?.enabled
			? EditorView.contentAttributes.of({
					spellcheck: 'true',
					...(opts.spellCheck.language ? { lang: opts.spellCheck.language } : {})
				})
			: [],
		placeholder(opts.placeholder),
		EditorView.lineWrapping,
		EditorView.updateListener.of((update) => {
			if (update.docChanged) opts.onDocChanged();
		})
	];
}
