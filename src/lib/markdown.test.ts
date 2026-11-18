import { describe, it, expect } from 'vitest';
import {
	findAssetReferences,
	renderMarkdown,
	renderReplyMarkdown,
	rewriteAssetReferences
} from './markdown';

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

describe('paragraph alignment markers', () => {
	it('aligns a marked paragraph and strips the marker', () => {
		const html = renderMarkdown('\\center The sign read:\n\nPlain paragraph.');
		expect(html).toContain('<p class="align-center">The sign read:</p>');
		expect(html).toContain('<p>Plain paragraph.</p>');
		expect(html).not.toContain('\\center');
	});

	it('supports right and justify the same way', () => {
		expect(renderMarkdown('\\right Yours,')).toContain('<p class="align-right">Yours,</p>');
		expect(renderMarkdown('\\justify Long text.')).toContain(
			'<p class="align-justify">Long text.</p>'
		);
	});

	it('leaves the marker alone when it is not at the paragraph start', () => {
		const html = renderMarkdown('The \\center marker mid-sentence.');
		expect(html).not.toContain('align-center');
		expect(html).toContain('\\center marker');
	});
});

describe('renderReplyMarkdown', () => {
	it('renders the Markdown models reply with', () => {
		const html = renderReplyMarkdown('**Bold**, *italic*, `code`.\n\n- one\n- two\n\n## Notes');
		expect(html).toContain('<strong>Bold</strong>');
		expect(html).toContain('<em>italic</em>');
		expect(html).toContain('<code>code</code>');
		expect(html).toContain('<li>one</li>');
		expect(html).toContain('<h2>Notes</h2>');
	});

	it('escapes raw HTML', () => {
		const html = renderReplyMarkdown('<script>alert(1)</script> <img src=x onerror=alert(1)>');
		expect(html).not.toContain('<script');
		expect(html).not.toContain('<img');
	});

	it('renders images as their alt text so no remote URL is fetched', () => {
		const html = renderReplyMarkdown('![the *gate*](https://example.com/leak?q=secret)');
		expect(html).not.toContain('<img');
		expect(html).not.toContain('example.com');
		expect(html).toContain('the gate');
	});

	it('escapes markup that reaches an image alt text', () => {
		const inputs = [
			'![&lt;img src=x onerror=alert(1)&gt;](https://example.com/a.png)',
			'![`<b>`](https://example.com/a.png)',
			'![\\<svg onload=alert(1)\\>](https://example.com/a.png)'
		];
		for (const input of inputs) {
			const html = renderReplyMarkdown(input);
			expect(html).not.toMatch(/<(img|b|svg)[\s>]/);
			expect(html).toContain('&lt;');
		}
	});

	it('opens web links in a new tab without a referrer', () => {
		const html = renderReplyMarkdown('[site](https://example.com)');
		expect(html).toContain(
			'<a href="https://example.com" target="_blank" rel="noopener noreferrer nofollow">site</a>'
		);
	});

	it('drops links that are not web or mail links', () => {
		for (const url of ['javascript:alert(1)', 'data:text/html,x', '/account', 'vbscript:x']) {
			const html = renderReplyMarkdown(`[click](${url})`);
			expect(html).not.toContain('<a');
		}
	});
});
