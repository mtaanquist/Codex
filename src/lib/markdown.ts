import MarkdownIt from 'markdown-it';
import { UUID_BODY } from './slug.ts';

// A paragraph containing exactly \page becomes an explicit page break:
// styled with a forced break in print and PDF, an inert empty element
// everywhere else. The marker survives in the markdown itself, so exports
// round-trip it as plain text.
function pageBreaks(md: MarkdownIt) {
	md.core.ruler.push('codex_page_break', (state) => {
		const tokens = state.tokens;
		for (let index = 0; index < tokens.length - 2; index++) {
			if (
				tokens[index].type === 'paragraph_open' &&
				tokens[index + 1].type === 'inline' &&
				tokens[index + 1].content.trim() === '\\page' &&
				tokens[index + 2].type === 'paragraph_close'
			) {
				const breakToken = new state.Token('html_block', '', 0);
				breakToken.content = '<div class="page-break"></div>\n';
				tokens.splice(index, 3, breakToken);
			}
		}
	});
}

// The one markdown renderer, shared by every surface that turns prose
// into HTML: exports, the print view, and later the public reading pages.
// Raw HTML stays off, so prose can never smuggle markup onto a page.
const renderer = new MarkdownIt({ html: false, linkify: false, typographer: false }).use(
	pageBreaks
);
// EPUB chapters are XHTML, which wants self-closed void elements.
const xhtmlRenderer = new MarkdownIt({ html: false, linkify: false, xhtmlOut: true }).use(
	pageBreaks
);

export function renderMarkdown(markdown: string, options: { xhtml?: boolean } = {}): string {
	return (options.xhtml ? xhtmlRenderer : renderer).render(markdown);
}

// Asset references in prose look like /assets/<uuid>; exports bundle the
// files and rewrite the links to a relative assets/ folder.
const ASSET_REFERENCE = new RegExp(`/assets/(${UUID_BODY})`, 'g');

export function findAssetReferences(markdown: string): string[] {
	const ids = new Set<string>();
	for (const match of markdown.matchAll(ASSET_REFERENCE)) {
		ids.add(match[1]);
	}
	return [...ids];
}

export function rewriteAssetReferences(
	markdown: string,
	pathFor: (assetId: string) => string
): string {
	return markdown.replace(ASSET_REFERENCE, (_, assetId: string) => pathFor(assetId));
}
