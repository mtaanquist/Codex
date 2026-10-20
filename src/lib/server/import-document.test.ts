import { describe, it, expect } from 'vitest';
import { strToU8, zipSync, type Zippable } from 'fflate';
import { parseDocument, DocumentImportError } from './import-document';
import { overlappingStoredZip } from '../../../tests/zip-fixtures';

// A real 1x1 PNG so the bytes survive the importer's magic-number sniff too.
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
	'base64'
);

function zip(files: Record<string, string | Uint8Array>): Uint8Array {
	const entries: Zippable = {};
	for (const [path, content] of Object.entries(files)) {
		entries[path] = typeof content === 'string' ? strToU8(content) : content;
	}
	return zipSync(entries);
}

// A minimal but valid .docx mammoth can read: content types, package rels, the
// main document part, its rels, and an embedded PNG.
function buildDocx(bodyXml: string, opts: { title?: string; author?: string } = {}): Uint8Array {
	return zip({
		'[Content_Types].xml': `<?xml version="1.0"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`,
		'_rels/.rels': `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`,
		'docProps/core.xml': `<?xml version="1.0"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:title>${opts.title ?? ''}</dc:title>
  <dc:creator>${opts.author ?? ''}</dc:creator>
</cp:coreProperties>`,
		'word/_rels/document.xml.rels': `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
</Relationships>`,
		'word/media/image1.png': new Uint8Array(PNG),
		'word/document.xml': `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
  <w:body>${bodyXml}</w:body>
</w:document>`
	});
}

function paragraph(text: string): string {
	return `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

function imageParagraph(): string {
	return `<w:p><w:r><w:drawing><wp:inline>
  <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
    <pic:pic><pic:blipFill><a:blip r:embed="rIdImg1"/></pic:blipFill></pic:pic>
  </a:graphicData></a:graphic>
</wp:inline></w:drawing></w:r></w:p>`;
}

describe('parseDocument (docx)', () => {
	it('reads the title and author and splits chapters and scenes', async () => {
		const docx = buildDocx(
			[
				paragraph('Chapter One'),
				paragraph('First scene prose.'),
				paragraph('* * *'),
				paragraph('Second scene prose.'),
				paragraph('Chapter Two'),
				paragraph('Closing prose.')
			].join(''),
			{ title: 'Test Manuscript', author: 'A. Writer' }
		);
		const plan = await parseDocument(docx, 'whatever.docx');
		expect(plan.story.title).toBe('Test Manuscript');
		expect(plan.story.author).toBe('A. Writer');
		expect(plan.chapters).toHaveLength(2);
		expect(plan.chapters[0].scenes.map((s) => s.bodyMd)).toEqual([
			'First scene prose.',
			'Second scene prose.'
		]);
		expect(plan.chapters[1].scenes[0].bodyMd).toBe('Closing prose.');
		expect(plan.unfiled).toEqual([]);
		expect(plan.notes).toEqual([]);
	});

	it('falls back to the filename when the document has no title', async () => {
		const docx = buildDocx(paragraph('Lonely prose.'));
		const plan = await parseDocument(docx, 'my-first-draft.docx');
		expect(plan.story.title).toBe('my first draft');
		expect(plan.chapters).toHaveLength(1);
		expect(plan.chapters[0].scenes).toHaveLength(1);
	});

	it('carries an embedded image as a bundled asset link', async () => {
		const docx = buildDocx([paragraph('Prose.'), imageParagraph()].join(''));
		const plan = await parseDocument(docx, 'book.docx');
		expect(plan.assets).toHaveLength(1);
		const asset = plan.assets[0];
		expect(asset.path).toBe(`${asset.id}.png`);
		expect(Buffer.from(asset.bytes).equals(PNG)).toBe(true);
		const body = plan.chapters
			.flatMap((c) => c.scenes)
			.map((s) => s.bodyMd)
			.join('\n');
		expect(body).toContain(`assets/${asset.id}.png`);
	});
});

// --- EPUB fixtures ---

function buildEpub(
	docs: { name: string; xhtml: string }[],
	opts: { title?: string; author?: string; withImage?: boolean } = {}
): Uint8Array {
	const manifestItems = docs
		.map((d, i) => `<item id="x${i}" href="${d.name}" media-type="application/xhtml+xml"/>`)
		.join('');
	const spine = docs.map((_, i) => `<itemref idref="x${i}"/>`).join('');
	const imageItem = opts.withImage
		? '<item id="img" href="images/pic.png" media-type="image/png"/>'
		: '';
	const files: Record<string, string | Uint8Array> = {
		mimetype: 'application/epub+zip',
		'META-INF/container.xml': `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
		'OEBPS/content.opf': `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${opts.title ?? 'An EPUB Book'}</dc:title>
    <dc:creator>${opts.author ?? 'E. Author'}</dc:creator>
  </metadata>
  <manifest>${manifestItems}${imageItem}</manifest>
  <spine>${spine}</spine>
</package>`
	};
	for (const d of docs) files[`OEBPS/${d.name}`] = `<html><body>${d.xhtml}</body></html>`;
	if (opts.withImage) files['OEBPS/images/pic.png'] = new Uint8Array(PNG);
	return zip(files);
}

describe('parseDocument (epub)', () => {
	it('splits chapters on per-file headings and reads metadata', async () => {
		const epub = buildEpub(
			[
				{ name: 'ch1.xhtml', xhtml: '<h1>The Beginning</h1><p>Once upon a time.</p>' },
				{ name: 'ch2.xhtml', xhtml: '<h1>The Middle</h1><p>Things happened.</p>' }
			],
			{ title: 'My EPUB', author: 'E. Author' }
		);
		const plan = await parseDocument(epub, 'ignored.epub');
		expect(plan.story.title).toBe('My EPUB');
		expect(plan.story.author).toBe('E. Author');
		expect(plan.chapters.map((c) => c.title)).toEqual(['The Beginning', 'The Middle']);
		expect(plan.chapters[0].scenes[0].bodyMd).toBe('Once upon a time.');
	});

	it('falls back to one chapter per spine document when there are no headings', async () => {
		const epub = buildEpub([
			{ name: 'a.xhtml', xhtml: '<p>Chapter without a heading.</p>' },
			{ name: 'b.xhtml', xhtml: '<p>Another file.</p>' }
		]);
		const plan = await parseDocument(epub, 'book.epub');
		expect(plan.chapters).toHaveLength(2);
		expect(plan.chapters[0].title).toBeNull();
		expect(plan.chapters[0].scenes[0].bodyMd).toBe('Chapter without a heading.');
		expect(plan.chapters[1].scenes[0].bodyMd).toBe('Another file.');
	});

	it('rewrites embedded image references and bundles the bytes', async () => {
		const epub = buildEpub(
			[{ name: 'ch1.xhtml', xhtml: '<h1>One</h1><p>See <img src="images/pic.png" alt="x"/></p>' }],
			{ withImage: true }
		);
		const plan = await parseDocument(epub, 'book.epub');
		expect(plan.assets).toHaveLength(1);
		const asset = plan.assets[0];
		expect(asset.path).toBe(`${asset.id}.png`);
		const body = plan.chapters
			.flatMap((c) => c.scenes)
			.map((s) => s.bodyMd)
			.join('\n');
		expect(body).toContain(`assets/${asset.id}.png`);
	});
});

// --- AO3 fixtures ---

// The shape of an AO3 EPUB download as Calibre writes it: a preface split
// across two files, one file per chapter under a repeated #chapters wrapper,
// renamed classes, and an afterword. Placeholder text only.
function ao3Preface(rating: string): string[] {
	return [
		`<div id="preface" class="calibre1">
  <h2 class="toc-heading">Preface</h2>
  <p class="message"><b class="calibre2">The Test Work</b><br class="calibre1"/>
    Posted originally on the <a href="https://archiveofourown.org/">Archive of Our Own</a> at <a href="https://archiveofourown.org/works/123">https://archiveofourown.org/works/123</a>.</p>
  <div class="calibre1"><dl class="tags">
    <dt class="calibre3">Rating:</dt><dd class="calibre4"><a href="https://archiveofourown.org/tags/x">${rating}</a></dd>
    <dt class="calibre3">Fandom:</dt><dd class="calibre4"><a href="#">Some Fandom</a></dd>
    <dt class="calibre3">Additional Tags:</dt><dd class="calibre4"><a href="#">Tag One</a>, <a href="#">Tag &amp; Two</a></dd>
    <dt class="calibre3">Series:</dt><dd class="calibre4">Part 1 of <a href="#">The Series</a></dd>
    <dt class="calibre3">Stats:</dt><dd class="calibre5">Published: 2020-01-01 Words: 100 Chapters: 2/2</dd>
  </dl></div>
</div>`,
		`<div id="preface" class="calibre1"><div class="calibre1">
  <h1 class="calibre6">The Test Work</h1>
  <div class="byline">by <a href="#" rel="author">tester</a></div>
  <p class="calibre7">Summary</p>
  <blockquote class="userstuff"><p class="calibre7">A short summary.</p></blockquote>
  <p class="calibre7">Notes</p>
  <blockquote class="userstuff"><p class="calibre7">A work note.</p></blockquote>
</div></div>
<div class="userstuff1" id="chapters"><div class="calibre1"><div class="calibre8"></div></div></div>`
	];
}

const AO3_CHAPTERS = [
	`<div class="userstuff1" id="chapters">
<div class="calibre1">
  <h2 class="heading">
    Chapter 1: The Start
  </h2>
  <p class="calibre7">Chapter Summary</p>
  <blockquote class="userstuff"><p class="calibre7">Chapter one summary.</p></blockquote>
  <p class="calibre7">Chapter Notes</p>
  <blockquote class="userstuff"><p class="calibre7">Chapter one note.</p></blockquote>
</div>
<div class="userstuff2"><hr class="calibre8"/><p class="calibre7">First scene.</p><p class="calibre7">***</p><p class="calibre7">Second scene.</p></div>
<div class="calibre1"><div class="calibre11"></div></div>
</div>`,
	`<div class="userstuff1" id="chapters">
<div class="calibre1">
  <h2 class="heading">Chapter 2</h2>
  <p class="calibre7">Chapter Notes</p>
  <div class="endnote-link">See the end of the chapter for <a href="#endnotes2">notes</a></div>
</div>
<div class="userstuff2"><p class="calibre7">Only scene.</p></div>
<div class="calibre1" id="endnotes2">
  <p class="calibre7">Chapter End Notes</p>
  <blockquote class="userstuff"><p class="calibre7">Chapter two end note.</p></blockquote>
</div>
</div>`
];

const AO3_AFTERWORD = `<div id="afterword" class="calibre1">
  <h2 class="toc-heading">Afterword</h2>
  <p class="calibre7">End Notes</p>
  <blockquote class="userstuff"><p class="calibre7">A work end note.</p></blockquote>
  <div class="calibre1"><dl class="calibre7"><dt class="calibre1">Works inspired by this one</dt><dd><a href="#">Another Work</a> by someone</dd></dl></div>
  <p class="message">Please <a href="#">drop by the Archive and comment</a> to let the creator know if you enjoyed their work!</p>
</div>`;

function buildAo3Epub(bodies: string[], publisher = 'Archive of Our Own'): Uint8Array {
	const manifest = bodies
		.map(
			(_, i) => `<item id="h${i}" href="w_split_${i}.xhtml" media-type="application/xhtml+xml"/>`
		)
		.join('');
	const spine = bodies.map((_, i) => `<itemref idref="h${i}"/>`).join('');
	const files: Record<string, string> = {
		mimetype: 'application/epub+zip',
		'META-INF/container.xml': `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
		'content.opf': `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>The Test Work</dc:title>
    <dc:creator>tester</dc:creator>
    <dc:publisher>${publisher}</dc:publisher>
  </metadata>
  <manifest>${manifest}</manifest>
  <spine>${spine}</spine>
</package>`
	};
	bodies.forEach((body, i) => {
		files[`w_split_${i}.xhtml`] =
			`<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body class="calibre">${body}</body></html>`;
	});
	return zip(files);
}

describe('parseDocument (AO3 epub)', () => {
	const fullWork = (rating = 'Explicit') =>
		buildAo3Epub([...ao3Preface(rating), ...AO3_CHAPTERS, AO3_AFTERWORD]);

	it('keeps the preface and afterword out of the chapters', async () => {
		const plan = await parseDocument(fullWork(), 'w.epub');
		expect(plan.story.title).toBe('The Test Work');
		expect(plan.story.author).toBe('tester');
		expect(plan.chapters.map((c) => c.title)).toEqual(['The Start', null]);
		const prose = plan.chapters.flatMap((c) => c.scenes.map((s) => s.bodyMd)).join('\n');
		expect(prose).not.toMatch(/Archive of Our Own|Notes|Summary|Works inspired|drop by/);
	});

	it('splits each chapter into scenes on its scene breaks', async () => {
		const plan = await parseDocument(fullWork(), 'w.epub');
		expect(plan.chapters[0].scenes.map((s) => s.bodyMd)).toEqual(['First scene.', 'Second scene.']);
		expect(plan.chapters[1].scenes.map((s) => s.bodyMd)).toEqual(['Only scene.']);
	});

	it('maps the summary, rating, and chapter summaries onto the story', async () => {
		const plan = await parseDocument(fullWork(), 'w.epub');
		expect(plan.story.descriptionMd).toBe('A short summary.');
		expect(plan.story.isAdult).toBe(true);
		expect(plan.chapters[0].summaryMd).toBe('Chapter one summary.');
		expect(plan.chapters[1].summaryMd).toBeNull();
		expect(plan.problems).toEqual([]);
	});

	it('flags Mature works adult and leaves other ratings alone', async () => {
		expect((await parseDocument(fullWork('Mature'), 'w.epub')).story.isAdult).toBe(true);
		expect((await parseDocument(fullWork('Teen And Up Audiences'), 'w.epub')).story.isAdult).toBe(
			false
		);
	});

	it('turns the tag list and every note into story notes', async () => {
		const plan = await parseDocument(fullWork(), 'w.epub');
		const notes = plan.freeformNotes ?? [];
		expect(notes.map((n) => [n.title, n.scene, n.pinned])).toEqual([
			['Archive of Our Own details', null, true],
			['Notes', null, false],
			['Chapter 1: The Start notes', { chapter: 0, index: 0 }, false],
			['Chapter 2 end notes', { chapter: 1, index: 0 }, false],
			['End notes', null, false]
		]);
		expect(notes[0].bodyMd).toBe(
			[
				'Imported from https://archiveofourown.org/works/123',
				'',
				'- **Rating:** Explicit',
				'- **Fandom:** Some Fandom',
				'- **Additional Tags:** Tag One, Tag & Two',
				'- **Series:** Part 1 of The Series'
			].join('\n')
		);
		expect(notes.map((n) => n.bodyMd).slice(1)).toEqual([
			'A work note.',
			'Chapter one note.',
			'Chapter two end note.',
			'A work end note.'
		]);
	});

	it('reads a one-chapter work with no chapter heading', async () => {
		const oneShot = `<div id="chapters" class="userstuff1"><div class="userstuff2"><p class="calibre7">The whole story.</p></div></div>`;
		const plan = await parseDocument(
			buildAo3Epub([...ao3Preface('General Audiences'), oneShot]),
			'w.epub'
		);
		expect(plan.chapters).toEqual([
			{
				title: null,
				summaryMd: null,
				scenes: [{ title: null, status: null, bodyMd: 'The whole story.' }]
			}
		]);
	});

	it('keeps headings and chapter lines inside the prose', async () => {
		const chapter = `<div id="chapters"><div><h2 class="heading">Chapter 1: One</h2></div><div><p>Chapter 1</p><h3>Part A</h3><p>Text.</p><p>* * *</p><h3>Part B</h3><p>More.</p></div></div>`;
		const plan = await parseDocument(buildAo3Epub([...ao3Preface('Explicit'), chapter]), 'w.epub');
		expect(plan.chapters[0].scenes.map((s) => s.bodyMd)).toEqual([
			'Chapter 1\n\n### Part A\n\nText.',
			'### Part B\n\nMore.'
		]);
	});

	it('gives a chapter with notes but no prose one empty scene for its notes', async () => {
		const chapter = `<div id="chapters"><div><h2 class="heading">Chapter 1</h2><p>Chapter Notes</p><blockquote><p>Note.</p></blockquote></div><div id="endnotes1"><p>Chapter End Notes</p><blockquote><p>End.</p></blockquote></div></div>`;
		const plan = await parseDocument(buildAo3Epub([...ao3Preface('Explicit'), chapter]), 'w.epub');
		expect(plan.chapters[0].scenes).toEqual([{ title: null, status: null, bodyMd: '' }]);
		expect(
			plan.freeformNotes?.filter((n) => n.title?.startsWith('Chapter')).map((n) => n.scene)
		).toEqual([
			{ chapter: 0, index: 0 },
			{ chapter: 0, index: 0 }
		]);
	});

	it('finds chapter headings by their text when the class was renamed', async () => {
		const chapters = `<div id="chapters"><div><h2 class="calibre9">Chapter 1: One</h2></div><div><p>A.</p></div><div><h2 class="calibre9">Chapter 2: Two</h2></div><div><p>B.</p></div></div>`;
		const plan = await parseDocument(buildAo3Epub([...ao3Preface('Explicit'), chapters]), 'w.epub');
		expect(plan.chapters.map((c) => c.title)).toEqual(['One', 'Two']);
	});

	it('does not lose prose after a closed void tag', async () => {
		const chapter = `<div id="chapters"><div><h2 class="heading">Chapter 1</h2></div><div><p>a<br></br>b</p></div><div><p>second</p></div></div>`;
		const plan = await parseDocument(buildAo3Epub([...ao3Preface('Explicit'), chapter]), 'w.epub');
		expect(plan.chapters).toHaveLength(1);
		expect(plan.chapters[0].scenes.map((s) => s.bodyMd)).toEqual([
			expect.stringMatching(/^a\s+b\n\nsecond$/)
		]);
	});

	it('skips a CDATA section when finding elements', async () => {
		const chapter = `<div id="chapters"><div><h2 class="heading">Chapter 1: One</h2></div><div><p>x<![CDATA[ <div> ]]></p></div><div><p>second</p></div></div>`;
		const plan = await parseDocument(buildAo3Epub([...ao3Preface('Explicit'), chapter]), 'w.epub');
		expect(plan.chapters.map((c) => c.title)).toEqual(['One']);
		expect(plan.story.isAdult).toBe(true);
	});

	it('reads the same markup the ordinary way when the publisher is not AO3', async () => {
		const plan = await parseDocument(
			buildAo3Epub([...ao3Preface('Explicit'), ...AO3_CHAPTERS], 'Someone Else'),
			'w.epub'
		);
		expect(plan.story.isAdult).toBeUndefined();
		expect(plan.chapters[0].title).toBe('Preface');
	});
});

// Rewrite the uncompressed size a zip declares for one entry, in both the
// central directory and the local header, to model an archive that lies about
// how large its contents are.
function setDeclaredSize(archive: Uint8Array, name: string, size: number): Uint8Array {
	const out = archive.slice();
	const view = new DataView(out.buffer);
	let eocd = out.length - 22;
	while (view.getUint32(eocd, true) !== 0x06054b50) eocd--;
	const count = view.getUint16(eocd + 10, true);
	let offset = view.getUint32(eocd + 16, true);
	for (let i = 0; i < count; i++) {
		const nameLength = view.getUint16(offset + 28, true);
		const extra = view.getUint16(offset + 30, true);
		const comment = view.getUint16(offset + 32, true);
		const entryName = new TextDecoder().decode(out.subarray(offset + 46, offset + 46 + nameLength));
		if (entryName === name) {
			view.setUint32(offset + 24, size, true);
			view.setUint32(view.getUint32(offset + 42, true) + 22, size, true);
			return out;
		}
		offset += 46 + nameLength + extra + comment;
	}
	throw new Error(`no entry named ${name}`);
}

describe('parseDocument (errors)', () => {
	it('rejects an unsupported extension', async () => {
		await expect(parseDocument(new Uint8Array([1, 2, 3]), 'file.txt')).rejects.toBeInstanceOf(
			DocumentImportError
		);
	});

	it('rejects a Word document with an entry declared too large to unpack', async () => {
		const docx = setDeclaredSize(
			buildDocx(paragraph('Hello.')),
			'word/document.xml',
			60 * 1024 * 1024
		);
		await expect(parseDocument(docx, 'big.docx')).rejects.toThrow(/too large to import/);
	});

	it('rejects a Word document whose entries add up to too much once unpacked', async () => {
		let docx = buildDocx(paragraph('Hello.'));
		for (const name of [
			'[Content_Types].xml',
			'_rels/.rels',
			'docProps/core.xml',
			'word/document.xml',
			'word/media/image1.png'
		]) {
			docx = setDeclaredSize(docx, name, 45 * 1024 * 1024);
		}
		await expect(parseDocument(docx, 'big.docx')).rejects.toThrow(
			/too large to import once unpacked/
		);
	});

	it('counts stored entries by their stored size, not the size they declare', async () => {
		await expect(
			parseDocument(overlappingStoredZip(11, 20 * 1024 * 1024), 'overlap.docx')
		).rejects.toThrow(/too large to import once unpacked/);
	});

	it('never unpacks more of an entry than the archive declares', async () => {
		const padding = 'x'.repeat(8 * 1024 * 1024);
		const docx = setDeclaredSize(
			buildDocx(paragraph('Opening.') + paragraph(padding) + paragraph('SENTINEL')),
			'word/document.xml',
			1024
		);
		const outcome = await parseDocument(docx, 'bomb.docx').then(
			(plan) => JSON.stringify(plan),
			(err: unknown) => err
		);
		if (typeof outcome === 'string') expect(outcome).not.toContain('SENTINEL');
		else expect(outcome).toBeInstanceOf(DocumentImportError);
	});

	it('rejects an empty file', async () => {
		await expect(parseDocument(new Uint8Array(), 'file.docx')).rejects.toBeInstanceOf(
			DocumentImportError
		);
	});
});
