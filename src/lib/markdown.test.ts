import { describe, it, expect } from 'vitest';
import { findAssetReferences, renderMarkdown, rewriteAssetReferences } from './markdown';

describe('renderMarkdown', () => {
	it('renders prose constructs', () => {
		const html = renderMarkdown('# Title\n\nA *quiet* paragraph.');
		expect(html).toContain('<h1>Title</h1>');
		expect(html).toContain('<em>quiet</em>');
	});

	it('escapes raw HTML instead of passing it through', () => {
		const html = renderMarkdown('Before <script>alert(1)</script> after.');
		expect(html).not.toContain('<script>');
		expect(html).toContain('&lt;script&gt;');
	});

	it('renders image references', () => {
		const html = renderMarkdown('![gate](/assets/0b154c2d-13ef-4f3c-9a85-2f1c0a9d8e11)');
		expect(html).toContain('<img src="/assets/0b154c2d-13ef-4f3c-9a85-2f1c0a9d8e11"');
	});

	it('turns a \\page paragraph into a page-break element', () => {
		const html = renderMarkdown('Before.\n\n\\page\n\nAfter.');
		expect(html).toContain('<div class="page-break"></div>');
		expect(html).not.toContain('\\page');
		expect(html).toContain('<p>Before.</p>');
		expect(html).toContain('<p>After.</p>');
	});

	it('leaves \\page alone when it is not a whole paragraph', () => {
		const html = renderMarkdown('The \\page marker mid-sentence.');
		expect(html).not.toContain('page-break');
		expect(html).toContain('\\page marker');
	});
});

describe('asset references', () => {
	const id = '0b154c2d-13ef-4f3c-9a85-2f1c0a9d8e11';
	const body = `One ![a](/assets/${id}) and again ![b](/assets/${id}).`;

	it('finds each referenced asset once', () => {
		expect(findAssetReferences(body)).toEqual([id]);
		expect(findAssetReferences('no images here')).toEqual([]);
	});

	it('rewrites references through the mapper', () => {
		const rewritten = rewriteAssetReferences(body, (assetId) => `assets/${assetId}.png`);
		expect(rewritten).toContain(`![a](assets/${id}.png)`);
		expect(rewritten).not.toContain('/assets/');
	});
});
