import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect } from 'vitest';
import {
	buildEditionHtml,
	chromiumPath,
	editionStoryContent,
	isolatePage,
	renderEditionPdf
} from './export-artifacts';
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

describe('isolatePage', () => {
	it('turns scripts off and lets only data: URIs through', async () => {
		const calls: string[] = [];
		let handler: ((request: FakeRequest) => void) | undefined;
		type FakeRequest = { url(): string; continue(): Promise<void>; abort(): Promise<void> };
		await isolatePage({
			setJavaScriptEnabled: async (enabled) => void calls.push(`js:${enabled}`),
			setRequestInterception: async (enabled) => void calls.push(`intercept:${enabled}`),
			on: (_event, fn) => (handler = fn)
		});
		expect(calls).toEqual(['js:false', 'intercept:true']);
		const decide = (url: string) => {
			let outcome = '';
			handler!({
				url: () => url,
				continue: async () => void (outcome = 'continue'),
				abort: async () => void (outcome = 'abort')
			});
			return outcome;
		};
		expect(decide('data:image/png;base64,AAAA')).toBe('continue');
		expect(decide('http://169.254.169.254/latest/meta-data/')).toBe('abort');
		expect(decide('http://rustfs:9000/bucket/key')).toBe('abort');
		expect(decide('https://example.com/a.png')).toBe('abort');
		expect(decide('file:///etc/passwd')).toBe('abort');
	});
});

// Drives the real browser where one is found (CHROMIUM_PATH or a system
// install); skipped on a machine without one.
describe.skipIf(!chromiumPath())('renderEditionPdf', () => {
	it('never fetches an external image or prefetch link', async () => {
		const hits: string[] = [];
		const server = createServer((req, res) => {
			hits.push(req.url ?? '');
			res.end();
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const { port } = server.address() as AddressInfo;
		try {
			const html = buildEditionHtml(
				{ title: 'Probe', author: null },
				{
					chapters: [{ id: 'c1', title: 'One' }],
					scenes: [
						{
							chapterId: 'c1',
							title: null,
							bodyMd: `Text ![](http://127.0.0.1:${port}/metadata) more.`
						}
					]
				},
				new Map()
			);
			expect(html).toContain(`http://127.0.0.1:${port}/metadata`);
			// Raw HTML is escaped in prose, so the prefetch is planted directly: it
			// bypasses request interception and only the dead proxy stops it.
			const probe = html.replace(
				'</head>',
				`<link rel="prefetch" href="http://127.0.0.1:${port}/prefetch"/></head>`
			);
			const pdf = await renderEditionPdf(probe);
			expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe('%PDF-');
			expect(hits).toEqual([]);
		} finally {
			server.close();
		}
	}, 30_000);
});
