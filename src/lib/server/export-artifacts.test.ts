import { describe, it, expect } from 'vitest';
import { buildEditionHtml, editionStoryContent } from './export-artifacts';
import type { EditionContent } from './publish';

const EDITION: EditionContent = {
	chapters: [
		{
			title: 'The Caravan',
			scenes: [
				{ title: 'Departure', bodyMd: 'The gate *opened*.' },
				{ title: 'Night', bodyMd: 'Stars over the road.' }
			]
		},
		{ title: null, scenes: [{ title: null, bodyMd: 'A nameless chapter.' }] }
	],
	unfiled: [{ title: 'Loose end', bodyMd: 'An unfiled thought.' }]
};

describe('editionStoryContent', () => {
	it('reshapes frozen content for the shared builders', () => {
		const content = editionStoryContent(EDITION);
		expect(content.chapters.map((c) => c.id)).toEqual(['ch-1', 'ch-2']);
		expect(content.scenes).toHaveLength(4);
		expect(content.scenes.filter((s) => s.chapterId === 'ch-1')).toHaveLength(2);
		expect(content.scenes.filter((s) => s.chapterId === null)).toHaveLength(1);
		// Order: chapter scenes in chapter order, unfiled last.
		expect(content.scenes[0].bodyMd).toBe('The gate *opened*.');
		expect(content.scenes.at(-1)?.bodyMd).toBe('An unfiled thought.');
	});
});

describe('buildEditionHtml', () => {
	const content = editionStoryContent(EDITION);

	it('builds a print-ready document with title page and chapter breaks', () => {
		const html = buildEditionHtml({ title: 'Book of Ash', author: 'A. Vane' }, content, new Map());
		expect(html).toContain('<h1>Book of Ash</h1>');
		expect(html).toContain('<p class="author">A. Vane</p>');
		expect(html).toContain('page-break-after: always');
		expect(html).toContain('page-break-before: always');
		expect(html).toContain('<h2>The Caravan</h2>');
		// An untitled chapter falls back to its number.
		expect(html).toContain('<h2>Chapter 2</h2>');
		expect(html).toContain('<h2>Unfiled scenes</h2>');
		// Prose renders through the shared markdown renderer.
		expect(html).toContain('<em>opened</em>');
		// Scenes in one chapter are separated by the printed scene break.
		expect(html).toContain('<hr class="scene-break"/>');
	});

	it('escapes html in titles and omits a missing author', () => {
		const html = buildEditionHtml({ title: '<b>Sly</b> & Co', author: null }, content, new Map());
		expect(html).toContain('&lt;b&gt;Sly&lt;/b&gt; &amp; Co');
		expect(html).not.toContain('class="author"');
	});

	it('inlines bundled images as data uris and drops unknown ones', () => {
		const id = '11111111-2222-3333-4444-555555555555';
		const other = '99999999-2222-3333-4444-555555555555';
		const withImage: EditionContent = {
			chapters: [
				{
					title: 'Art',
					scenes: [{ title: null, bodyMd: `![a](/assets/${id})\n\n![b](/assets/${other})` }]
				}
			],
			unfiled: []
		};
		const images = new Map([
			[id, { id, contentType: 'image/png', bytes: new Uint8Array([1, 2, 3]) }]
		]);
		const html = buildEditionHtml(
			{ title: 'T', author: null },
			editionStoryContent(withImage),
			images
		);
		expect(html).toContain(`data:image/png;base64,${Buffer.from([1, 2, 3]).toString('base64')}`);
		expect(html).not.toContain(`/assets/${id}`);
		// The unknown reference rewrites to an empty src rather than leaking a path.
		expect(html).not.toContain(`/assets/${other}`);
	});
});
