import { strToU8, zipSync, type Zippable } from 'fflate';
import type { Database } from './auth';
import { findAssetReferences, renderMarkdown, rewriteAssetReferences } from '$lib/markdown';
import { gatherStory, type AssetLoader, type ExportAsset, type ExportStory } from './export';
import { extensionFor } from './media-types';

// A minimal EPUB 3 by hand: it is a zip whose first entry is the literal
// string "application/epub+zip", stored uncompressed, plus a container
// pointer, an OPF manifest and spine, a nav document, and XHTML chapters.
// The libraries in this space are stale; owning ~150 lines beats them.

function escapeXml(text: string): string {
	return text
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}

const STYLE = `body { font-family: serif; line-height: 1.6; }
h1 { text-align: center; margin: 2em 0 1.5em; }
img { max-width: 100%; }
p { margin: 0 0 1em; text-indent: 1.25em; }
p:first-of-type { text-indent: 0; }`;

function xhtmlDocument(title: string, body: string): string {
	return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>${escapeXml(title)}</title><link rel="stylesheet" href="style.css"/></head>
<body>${body}</body>
</html>`;
}

export async function buildEpub(
	db: Database,
	story: ExportStory,
	loadAssets: AssetLoader,
	coverAssetId: string | null
): Promise<{ filename: string; bytes: Uint8Array }> {
	const { chapters: chapterList, scenes: sceneList } = await gatherStory(db, story);

	const referenced = sceneList.flatMap((scene) => findAssetReferences(scene.bodyMd));
	const wanted = [...new Set([...referenced, ...(coverAssetId ? [coverAssetId] : [])])];
	const loaded = await loadAssets(wanted);
	const images = new Map<string, ExportAsset>(loaded.map((asset) => [asset.id, asset]));
	const imageFile = (id: string) =>
		`images/${id}.${extensionFor(images.get(id)?.contentType ?? '')}`;

	// Sections: each chapter is one XHTML file; chapterless scenes close
	// the book as an unfiled section.
	type Section = { id: string; title: string; html: string };
	const sections: Section[] = [];
	const renderScenes = (list: typeof sceneList) =>
		list
			.map((scene) => {
				const body = rewriteAssetReferences(scene.bodyMd, (id) =>
					images.has(id) ? imageFile(id) : ''
				);
				return renderMarkdown(body, { xhtml: true });
			})
			.join('\n<hr/>\n');
	chapterList.forEach((chapter, index) => {
		const inChapter = sceneList.filter((scene) => scene.chapterId === chapter.id);
		if (inChapter.length === 0) return;
		const title = chapter.title ?? `Chapter ${index + 1}`;
		sections.push({
			id: `ch${index + 1}`,
			title,
			html: `<h1>${escapeXml(title)}</h1>\n${renderScenes(inChapter)}`
		});
	});
	const unfiled = sceneList.filter((scene) => scene.chapterId === null);
	if (unfiled.length > 0) {
		sections.push({
			id: 'unfiled',
			title: 'Unfiled scenes',
			html: `<h1>Unfiled scenes</h1>\n${renderScenes(unfiled)}`
		});
	}

	const manifestItems = [
		'<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
		'<item id="style" href="style.css" media-type="text/css"/>',
		...sections.map(
			(section) =>
				`<item id="${section.id}" href="${section.id}.xhtml" media-type="application/xhtml+xml"/>`
		),
		...[...images.values()].map(
			(asset) =>
				`<item id="img-${asset.id}" href="${imageFile(asset.id)}" media-type="${asset.contentType}"${
					asset.id === coverAssetId ? ' properties="cover-image"' : ''
				}/>`
		)
	];
	const spineItems = sections.map((section) => `<itemref idref="${section.id}"/>`);

	const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="pub-id">urn:uuid:${story.id}</dc:identifier>
<dc:title>${escapeXml(story.title)}</dc:title>
${story.author ? `<dc:creator>${escapeXml(story.author)}</dc:creator>` : ''}
<dc:language>en</dc:language>
<meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}</meta>
</metadata>
<manifest>
${manifestItems.join('\n')}
</manifest>
<spine>
${spineItems.join('\n')}
</spine>
</package>`;

	const nav = xhtmlDocument(
		story.title,
		`<nav epub:type="toc"><h1>${escapeXml(story.title)}</h1><ol>${sections
			.map((section) => `<li><a href="${section.id}.xhtml">${escapeXml(section.title)}</a></li>`)
			.join('')}</ol></nav>`
	);

	const files: Zippable = {
		// Per the spec: first entry, exactly this name, stored uncompressed.
		mimetype: [strToU8('application/epub+zip'), { level: 0 }],
		'META-INF/container.xml': strToU8(`<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`),
		'OEBPS/content.opf': strToU8(opf),
		'OEBPS/nav.xhtml': strToU8(nav),
		'OEBPS/style.css': strToU8(STYLE)
	};
	for (const section of sections) {
		files[`OEBPS/${section.id}.xhtml`] = strToU8(xhtmlDocument(section.title, section.html));
	}
	for (const asset of images.values()) {
		files[`OEBPS/${imageFile(asset.id)}`] = asset.bytes;
	}

	return {
		filename: `${story.title ? story.title.replace(/[^\w-]+/g, '-') : 'story'}.epub`,
		bytes: zipSync(files)
	};
}
