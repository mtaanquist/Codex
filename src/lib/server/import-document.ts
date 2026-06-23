import { randomUUID } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import TurndownService from 'turndown';
import mammoth from 'mammoth';
import { detectStructure, markdownToBlocks, type DocBlock } from '../import-document-structure';
import type { ImportedAsset, ImportPlan } from '../import-markdown';
import { extensionFor } from './media-types';

// Builds an ImportPlan from a Word (.docx) or EPUB (.epub) manuscript: convert
// the document to markdown blocks, let detectStructure guess chapters and
// scenes, and carry embedded images as assets the importer can store. Pure over
// the file bytes; previewImport/runImport take it from here, exactly as they do
// a story-export zip.

export class DocumentImportError extends Error {}

const MAX_INPUT_BYTES = 25 * 1024 * 1024;
const MAX_ENTRIES = 5000;
const MAX_ENTRY_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;

export async function parseDocument(bytes: Uint8Array, filename: string): Promise<ImportPlan> {
	if (bytes.length === 0) throw new DocumentImportError('This file is empty.');
	if (bytes.length > MAX_INPUT_BYTES) {
		throw new DocumentImportError('This file is too large to import (the limit is 25 MB).');
	}
	const extension = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
	if (extension === 'docx') return parseDocx(bytes, filename);
	if (extension === 'epub') return parseEpub(bytes, filename);
	throw new DocumentImportError('Codex can import Word (.docx) and EPUB (.epub) files.');
}

// Turndown escapes literal markdown characters in text, which would turn a
// scene break typed as "***" into "\*\*\*" and hide it from the detector.
// Manuscripts rarely contain deliberate markdown syntax, so leaving text
// verbatim is both safer for break detection and more faithful to the source.
function htmlToMarkdown(html: string): string {
	const service = new TurndownService({
		headingStyle: 'atx',
		bulletListMarker: '-',
		codeBlockStyle: 'fenced',
		hr: '* * *',
		emDelimiter: '*'
	});
	service.escape = (text) => text;
	service.remove(['script', 'style', 'title']);
	return service.turndown(html);
}

function htmlToBlocks(html: string): DocBlock[] {
	return markdownToBlocks(htmlToMarkdown(html));
}

function fileStem(filename: string): string {
	const base = filename.split(/[\\/]/).pop() ?? filename;
	return base
		.replace(/\.[^.]+$/, '')
		.replace(/[_-]+/g, ' ')
		.trim();
}

function buildPlan(
	title: string | null,
	author: string | null,
	chapters: ImportPlan['chapters'],
	assets: ImportedAsset[],
	problems: string[]
): ImportPlan {
	return {
		story: {
			title: title?.trim() || 'Imported story',
			author: author?.trim() || null,
			brief: null,
			descriptionMd: ''
		},
		chapters,
		unfiled: [],
		notes: [],
		assets,
		problems
	};
}

// --- DOCX ---

async function parseDocx(bytes: Uint8Array, filename: string): Promise<ImportPlan> {
	const assets: ImportedAsset[] = [];
	const convertImage = mammoth.images.imgElement(async (image) => {
		const buffer = await image.read();
		const id = randomUUID();
		const path = `${id}.${extensionFor(image.contentType ?? '')}`;
		assets.push({ id, path, bytes: new Uint8Array(buffer) });
		return { src: `assets/${path}` };
	});

	let html: string;
	try {
		const result = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) }, { convertImage });
		html = result.value;
	} catch {
		throw new DocumentImportError('This file could not be read as a Word document.');
	}

	const { chapters, problems } = detectStructure(htmlToBlocks(html));
	const core = docxCoreProperties(bytes);
	return buildPlan(core.title ?? fileStem(filename), core.author, chapters, assets, problems);
}

// Word stores its title and author in docProps/core.xml; read just that entry
// rather than decompressing the whole archive a second time.
function docxCoreProperties(bytes: Uint8Array): { title: string | null; author: string | null } {
	try {
		const entries = unzipSync(bytes, { filter: (file) => file.name === 'docProps/core.xml' });
		const core = entries['docProps/core.xml'];
		if (!core) return { title: null, author: null };
		const xml = strFromU8(core);
		return { title: tagText(xml, 'dc:title'), author: tagText(xml, 'dc:creator') };
	} catch {
		return { title: null, author: null };
	}
}

// --- EPUB ---

async function parseEpub(bytes: Uint8Array, filename: string): Promise<ImportPlan> {
	const entries = unzipGuarded(bytes);
	const container = entries['META-INF/container.xml'];
	if (!container) throw new DocumentImportError('This EPUB is missing its container file.');
	const opfPath = attr(strFromU8(container), 'full-path');
	if (!opfPath || !entries[opfPath]) {
		throw new DocumentImportError('This EPUB does not point to a readable package file.');
	}
	const opf = strFromU8(entries[opfPath]);
	const opfDir = posixDirname(opfPath);

	const manifest = new Map<string, string>();
	for (const tag of opf.match(/<item\b[^>]*\/?>/g) ?? []) {
		const id = attr(tag, 'id');
		const href = attr(tag, 'href');
		if (id && href) manifest.set(id, href);
	}
	const spine: string[] = [];
	for (const tag of opf.match(/<itemref\b[^>]*\/?>/g) ?? []) {
		const idref = attr(tag, 'idref');
		if (idref) spine.push(idref);
	}

	const assets: ImportedAsset[] = [];
	const files: { title: string | null; blocks: DocBlock[] }[] = [];
	for (const idref of spine) {
		const href = manifest.get(idref);
		if (!href) continue;
		const path = posixResolve(opfDir, decodeURIComponent(href.split('#')[0]));
		const data = entries[path];
		if (!data || !/\.x?html?$/i.test(path)) continue;
		const rewritten = rewriteEpubImages(strFromU8(data), path, entries, assets);
		const blocks = htmlToBlocks(extractBody(rewritten));
		if (blocks.length === 0) continue;
		const firstHeading = blocks.find((b) => b.kind === 'heading');
		files.push({
			title: firstHeading?.kind === 'heading' ? firstHeading.text.trim() || null : null,
			blocks
		});
	}

	const title = tagText(opf, 'dc:title') ?? fileStem(filename);
	const author = tagText(opf, 'dc:creator');

	// Headings win when the book marks chapters with them. Otherwise fall back to
	// the EPUB's own file split: one spine document per chapter, the convention
	// most reflowable EPUBs follow.
	const combined = detectStructure(files.flatMap((file) => file.blocks));
	if (combined.chapters.length > 1 || files.length <= 1) {
		return buildPlan(title, author, combined.chapters, assets, combined.problems);
	}

	const chapters = files.map((file) => ({
		title: file.title,
		scenes: detectStructure(file.blocks).chapters.flatMap((chapter) => chapter.scenes)
	}));
	return buildPlan(title, author, chapters, assets, []);
}

function rewriteEpubImages(
	html: string,
	filePath: string,
	entries: Record<string, Uint8Array>,
	assets: ImportedAsset[]
): string {
	const dir = posixDirname(filePath);
	return html.replace(/<img\b[^>]*>/gi, (tag) => {
		const src = attr(tag, 'src');
		if (!src) return tag;
		const resolved = posixResolve(dir, decodeURIComponent(src.split('#')[0]));
		const data = entries[resolved];
		if (!data) return tag;
		const ext = resolved.slice(resolved.lastIndexOf('.') + 1).toLowerCase() || 'bin';
		const id = randomUUID();
		const path = `${id}.${ext}`;
		assets.push({ id, path, bytes: data });
		return tag.replace(/\bsrc\s*=\s*("[^"]*"|'[^']*')/i, `src="assets/${path}"`);
	});
}

// --- shared XML/zip/path helpers ---

function unzipGuarded(bytes: Uint8Array): Record<string, Uint8Array> {
	let count = 0;
	let total = 0;
	try {
		return unzipSync(bytes, {
			filter(file) {
				if (++count > MAX_ENTRIES) {
					throw new DocumentImportError('This EPUB has too many files to import.');
				}
				if (file.originalSize > MAX_ENTRY_BYTES) {
					throw new DocumentImportError('This EPUB contains a file that is too large to import.');
				}
				total += file.originalSize;
				if (total > MAX_TOTAL_BYTES) {
					throw new DocumentImportError('This EPUB is too large to import once unpacked.');
				}
				return true;
			}
		});
	} catch (err) {
		if (err instanceof DocumentImportError) throw err;
		throw new DocumentImportError('This file could not be read as an EPUB.');
	}
}

function decodeEntities(text: string): string {
	return text
		.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, '&');
}

// The first value of an attribute on a single tag string, single or double
// quoted. Enough for the constrained, well-formed XML of EPUB packages.
function attr(tag: string, name: string): string | null {
	const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
	if (!match) return null;
	return decodeEntities(match[1] ?? match[2] ?? '');
}

function tagText(xml: string, tag: string): string | null {
	const match = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
	if (!match) return null;
	const text = decodeEntities(match[1].replace(/<[^>]+>/g, '')).trim();
	return text === '' ? null : text;
}

function extractBody(html: string): string {
	const match = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
	return match ? match[1] : html;
}

function posixDirname(path: string): string {
	const slash = path.lastIndexOf('/');
	return slash < 0 ? '' : path.slice(0, slash);
}

function posixResolve(dir: string, rel: string): string {
	const segments = dir === '' ? [] : dir.split('/');
	for (const part of rel.split('/')) {
		if (part === '' || part === '.') continue;
		if (part === '..') segments.pop();
		else segments.push(part);
	}
	return segments.join('/');
}
