import { showPanel, type EditorView, type Panel } from '@codemirror/view';
import { StateField, type Extension } from '@codemirror/state';
import { getSearchQuery, searchPanelOpen } from '@codemirror/search';

// A "Search in" row under the editor's find panel (Ctrl+F). "This scene" is
// the panel itself; the chapter and story choices hand the search over to the
// page, which opens find and replace across that wider scope.

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
		label.id = `cm-search-scope-${Math.random().toString(36).slice(2)}`;
		label.textContent = 'Search in';
		const group = document.createElement('div');
		group.className = 'seg';
		group.setAttribute('role', 'group');
		group.setAttribute('aria-labelledby', label.id);
		const button = (text: string, scope: SearchScope | null) => {
			const el = document.createElement('button');
			el.type = 'button';
			el.className = scope ? 'seg-btn' : 'seg-btn active';
			el.textContent = text;
			el.setAttribute('aria-pressed', scope ? 'false' : 'true');
			if (scope) {
				el.addEventListener('click', () => {
					const query = getSearchQuery(view.state);
					wider.open(scope, {
						find: query.search,
						matchCase: query.caseSensitive,
						wholeWord: query.wholeWord
					});
				});
			}
			group.append(el);
		};
		button('This scene', null);
		if (wider.hasChapter()) button('This chapter', 'chapter');
		button('Whole story', 'story');
		dom.append(label, group);
		return { dom, top: false };
	};
	return StateField.define<boolean>({
		create: (state) => searchPanelOpen(state),
		update: (_, tr) => searchPanelOpen(tr.state),
		provide: (field) => showPanel.from(field, (open) => (open ? create : null))
	});
}
