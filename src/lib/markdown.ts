import MarkdownIt from 'markdown-it';

// The one markdown renderer, shared by every surface that turns prose
// into HTML: exports, the print view, and later the public reading pages.
// Raw HTML stays off, so prose can never smuggle markup onto a page.
const renderer = new MarkdownIt({ html: false, linkify: false, typographer: false });
// EPUB chapters are XHTML, which wants self-closed void elements.
const xhtmlRenderer = new MarkdownIt({ html: false, linkify: false, xhtmlOut: true });

export function renderMarkdown(markdown: string, options: { xhtml?: boolean } = {}): string {
	return (options.xhtml ? xhtmlRenderer : renderer).render(markdown);
}

// Asset references in prose look like /assets/<uuid>; exports bundle the
// files and rewrite the links to a relative assets/ folder.
const ASSET_REFERENCE = /\/assets\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;

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
