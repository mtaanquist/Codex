import { describe, it, expect } from 'vitest';
import { strToU8, zipSync, type Zippable } from 'fflate';
import { parseDocument, DocumentImportError } from './import-document';

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

describe('parseDocument (errors)', () => {
	it('rejects an unsupported extension', async () => {
		await expect(parseDocument(new Uint8Array([1, 2, 3]), 'file.txt')).rejects.toBeInstanceOf(
			DocumentImportError
		);
	});

	it('rejects an empty file', async () => {
		await expect(parseDocument(new Uint8Array(), 'file.docx')).rejects.toBeInstanceOf(
			DocumentImportError
		);
	});
});
