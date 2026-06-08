import { EditorView, keymap, placeholder } from '@codemirror/view';
import { Compartment, type Extension } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { search, searchKeymap } from '@codemirror/search';
import { markdown } from '@codemirror/lang-markdown';
import { markdownStyling, richModeExtension } from './editor-richtext';
import { formatKeymap } from './editor-format';
import { enterKeymap } from './editor-enter';
import { alignmentExtension } from './editor-alignment';
import { nonPrintingExtension } from './editor-nonprinting';

export type EditingMode = 'markdown' | 'rich';
export type MarkVisibility = 'shown' | 'hidden';

// The alignment decorations for the current command-marker setting, and the
// non-printing glyphs for its setting. Single source for both the initial
// config and the toolbar's runtime reconfigure, so the two never drift.
export function alignmentFor(commandMarkers: MarkVisibility): Extension {
	return alignmentExtension(commandMarkers === 'hidden');
}
export function nonPrintingFor(nonPrintingMarks: MarkVisibility): Extension {
	return nonPrintingMarks === 'shown' ? nonPrintingExtension() : [];
}

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
	// The prose-view toggles, defaulting to the stored defaults. Hosts that
	// flip them at runtime pass compartments to wrap the matching slot.
	nonPrintingMarks?: MarkVisibility;
	commandMarkers?: MarkVisibility;
	compartments?: { nonPrinting?: Compartment; alignment?: Compartment };
}): Extension[] {
	const alignment = alignmentFor(opts.commandMarkers ?? 'shown');
	const nonPrinting = nonPrintingFor(opts.nonPrintingMarks ?? 'hidden');
	return [
		history(),
		keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
		// Enter makes a paragraph (Shift+Enter is a soft break); the prose
		// editors store markdown, where that is the natural break.
		opts.plain ? [] : enterKeymap(),
		opts.plain ? [] : formatKeymap(),
		// Find and replace within the scene; Ctrl+F opens the panel.
		search(),
		opts.plain
			? []
			: [
					markdown(),
					markdownStyling(),
					opts.compartments?.alignment ? opts.compartments.alignment.of(alignment) : alignment,
					opts.compartments?.nonPrinting
						? opts.compartments.nonPrinting.of(nonPrinting)
						: nonPrinting
				],
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
