import { showPanel, type EditorView, type Panel } from '@codemirror/view';
import { StateField, type Extension } from '@codemirror/state';
import { getSearchQuery, searchPanelOpen } from '@codemirror/search';

// A row under the editor's find panel (Ctrl+F) that hands the search over to
// the page, which opens find and replace across the chapter or the story.

export type SearchScope = 'chapter' | 'story';
export type WiderSearch = {
	// Whether the scene sits in a chapter; an unfiled scene offers the story only.
	hasChapter: () => boolean;
	open: (
		scope: SearchScope,
		query: { find: string; matchCase: boolean; wholeWord: boolean }
	) => void;
};

export function searchScopeExtension(wider: WiderSearch): Extension {
	const create = (view: EditorView): Panel => {
		const dom = document.createElement('div');
		dom.className = 'cm-search-scope';
		const label = document.createElement('span');
		label.className = 'cm-search-scope-label';
		label.textContent = 'Find and replace in';
		dom.append(label);
		const button = (text: string, scope: SearchScope) => {
			const el = document.createElement('button');
			el.type = 'button';
			el.className = 'cm-button';
			el.textContent = text;
			el.setAttribute('aria-haspopup', 'dialog');
			el.addEventListener('click', () => {
				const query = getSearchQuery(view.state);
				wider.open(scope, {
					find: query.search,
					matchCase: query.caseSensitive,
					wholeWord: query.wholeWord
				});
			});
			dom.append(el);
		};
		if (wider.hasChapter()) button('This chapter...', 'chapter');
		button('Whole story...', 'story');
		return { dom, top: false };
	};
	return StateField.define<boolean>({
		create: (state) => searchPanelOpen(state),
		update: (_, tr) => searchPanelOpen(tr.state),
		provide: (field) => showPanel.from(field, (open) => (open ? create : null))
	});
}
