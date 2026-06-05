import { existsSync } from 'node:fs';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Database } from './auth';
import { exportArtifacts, publications, stories } from './db/schema.ts';
import { assetConfig, s3AssetStore, type AssetObjectStore } from './assets.ts';
import {
	bucketAssetLoader,
	buildStoryZip,
	slugify,
	type AssetLoader,
	type ExportAsset,
	type ExportStory,
	type StoryContent
} from './export.ts';
import { buildEpub } from './epub.ts';
import type { EditionContent } from './publish.ts';
import { findAssetReferences, renderMarkdown, rewriteAssetReferences } from '../markdown.ts';

// Stored export artifacts: when an edition publishes, the worker generates
// its markdown zip, EPUB, and PDF from the frozen content and keeps them in
// the asset bucket, the way a release carries assets. Everything here is
// derived data; regeneration overwrites in place. Runs in the worker, so
// relative value imports carry explicit .ts extensions.

export type ArtifactFormat = 'markdown' | 'epub' | 'pdf';

// A frozen edition reshaped for the shared export builders. Chapters get
// synthetic ids; editions do not keep the original ones.
export function editionStoryContent(content: EditionContent): StoryContent {
	return {
		chapters: content.chapters.map((chapter, index) => ({
			id: `ch-${index + 1}`,
			title: chapter.title
		})),
		scenes: [
			...content.chapters.flatMap((chapter, index) =>
				chapter.scenes.map((scene) => ({
					chapterId: `ch-${index + 1}`,
					title: scene.title,
					bodyMd: scene.bodyMd
				}))
			),
			...content.unfiled.map((scene) => ({
				chapterId: null,
				title: scene.title,
				bodyMd: scene.bodyMd
			}))
		]
	};
}

function escapeHtml(text: string): string {
	return text
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}

// The print stylesheet, kept in step with the browser print route
// (src/routes/stories/[id]/print): title page, a fresh page per chapter,
// and "* * *" scene breaks.
const PDF_CSS = `body { font-family: Georgia, 'Times New Roman', serif; font-size: 12pt; line-height: 1.6; color: #000; margin: 0; }
.title-page { text-align: center; margin: 4rem 0 6rem; page-break-after: always; }
.title-page h1 { font-size: 28pt; font-weight: 600; }
.author { margin-top: 1rem; font-size: 14pt; }
.chapter { page-break-before: always; }
.chapter h2 { text-align: center; font-size: 18pt; margin: 3rem 0 2rem; }
.scene-break { border: 0; text-align: center; margin: 2rem 0; }
.scene-break::after { content: '* * *'; color: #444; }
.chapter p { margin: 0 0 0.2rem; text-indent: 1.5em; }
img { max-width: 100%; }
@page { margin: 2cm; }`;

// A complete print-ready HTML document for the PDF renderer. Images are
// inlined as data URIs so the headless browser never needs the network.
export function buildEditionHtml(
	meta: { title: string; author: string | null },
	content: StoryContent,
	images: Map<string, ExportAsset>
): string {
	const dataUri = (id: string) => {
		const asset = images.get(id);
		return asset
			? `data:${asset.contentType};base64,${Buffer.from(asset.bytes).toString('base64')}`
			: '';
	};
	const renderScenes = (list: StoryContent['scenes']) =>
		list
			.map((scene) => renderMarkdown(rewriteAssetReferences(scene.bodyMd, dataUri)))
			.join('\n<hr class="scene-break"/>\n');

	const sections: string[] = [];
	content.chapters.forEach((chapter, index) => {
		const inChapter = content.scenes.filter((scene) => scene.chapterId === chapter.id);
		if (inChapter.length === 0) return;
		const title = chapter.title ?? `Chapter ${index + 1}`;
		sections.push(
			`<section class="chapter"><h2>${escapeHtml(title)}</h2>\n${renderScenes(inChapter)}</section>`
		);
	});
	const unfiled = content.scenes.filter((scene) => scene.chapterId === null);
	if (unfiled.length > 0) {
		sections.push(
			`<section class="chapter"><h2>Unfiled scenes</h2>\n${renderScenes(unfiled)}</section>`
		);
	}

	return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"/><title>${escapeHtml(meta.title)}</title><style>${PDF_CSS}</style></head>
<body>
<header class="title-page"><h1>${escapeHtml(meta.title)}</h1>${
		meta.author ? `<p class="author">${escapeHtml(meta.author)}</p>` : ''
	}</header>
${sections.join('\n')}
</body>
</html>`;
}

function chromiumPath(): string | null {
	if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
	for (const path of ['/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome']) {
		if (existsSync(path)) return path;
	}
	return null;
}

// Renders the document with headless Chromium via puppeteer-core, driving
// the system browser (installed in the Docker image; CHROMIUM_PATH points
// elsewhere when needed). Loaded lazily so nothing outside the worker's PDF
// path pays for it.
export async function renderEditionPdf(html: string): Promise<Uint8Array> {
	const executablePath = chromiumPath();
	if (!executablePath) {
		throw new Error('no Chromium found; set CHROMIUM_PATH or install the chromium package');
	}
	const { launch } = await import('puppeteer-core');
	const browser = await launch({
		executablePath,
		// Sandboxing is off because the container already isolates the process,
		// and the rendered HTML is built from author prose with raw HTML escaped.
		args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
	});
	try {
		const page = await browser.newPage();
		await page.setContent(html, { waitUntil: 'load' });
		const pdf = await page.pdf({ format: 'a4' });
		return new Uint8Array(pdf);
	} finally {
		await browser.close();
	}
}

export type GenerateResult =
	| { ok: true; stored: ArtifactFormat[]; failed: { format: ArtifactFormat; error: string }[] }
	| { ok: false; reason: string };

// Test seams: the real store, loader, and PDF renderer are replaceable so
// the bookkeeping is testable without a bucket or a browser.
export type ArtifactDeps = {
	store?: AssetObjectStore;
	loadAssets?: AssetLoader;
	renderPdf?: (html: string) => Promise<Uint8Array>;
	prefix?: string;
};

// Builds and stores all three artifacts for an edition. Formats fail
// independently: a missing Chromium still leaves the zip and EPUB stored,
// and the failure is reported for the worker log. Overwrites previous
// artifacts in place (deterministic keys, one row per format).
export async function generateEditionArtifacts(
	db: Database,
	publicationId: string,
	deps: ArtifactDeps = {}
): Promise<GenerateResult> {
	const config = assetConfig();
	if (!config && !(deps.store && deps.prefix !== undefined)) {
		return { ok: false, reason: 'asset storage is not configured' };
	}
	const prefix = deps.prefix ?? config!.prefix;
	const store = deps.store ?? s3AssetStore(config!);

	const [edition] = await db
		.select({
			id: publications.id,
			title: publications.title,
			author: publications.author,
			descriptionMd: publications.descriptionMd,
			content: publications.content,
			removedAt: publications.removedAt,
			coverAssetId: stories.coverAssetId
		})
		.from(publications)
		.innerJoin(stories, eq(publications.storyId, stories.id))
		.where(eq(publications.id, publicationId));
	if (!edition) return { ok: false, reason: 'publication not found' };
	if (edition.removedAt) return { ok: false, reason: 'edition was taken down' };

	const story: ExportStory = {
		id: edition.id,
		title: edition.title,
		author: edition.author,
		brief: null,
		descriptionMd: edition.descriptionMd
	};
	const content = editionStoryContent(edition.content as EditionContent);
	const loadAssets = deps.loadAssets ?? bucketAssetLoader(db);
	const renderPdf = deps.renderPdf ?? renderEditionPdf;
	const slug = slugify(edition.title, 'story');

	const builders: {
		format: ArtifactFormat;
		build: () => Promise<{ filename: string; bytes: Uint8Array; contentType: string }>;
	}[] = [
		{
			format: 'markdown',
			build: async () => {
				const zip = await buildStoryZip(story, content, loadAssets);
				return { ...zip, contentType: 'application/zip' };
			}
		},
		{
			format: 'epub',
			build: async () => {
				const epub = await buildEpub(story, content, loadAssets, edition.coverAssetId);
				return { ...epub, contentType: 'application/epub+zip' };
			}
		},
		{
			format: 'pdf',
			build: async () => {
				const referenced = [
					...new Set(content.scenes.flatMap((scene) => findAssetReferences(scene.bodyMd)))
				];
				const images = new Map((await loadAssets(referenced)).map((asset) => [asset.id, asset]));
				const html = buildEditionHtml(
					{ title: edition.title, author: edition.author },
					content,
					images
				);
				return {
					filename: `${slug}.pdf`,
					bytes: await renderPdf(html),
					contentType: 'application/pdf'
				};
			}
		}
	];

	const stored: ArtifactFormat[] = [];
	const failed: { format: ArtifactFormat; error: string }[] = [];
	for (const { format, build } of builders) {
		try {
			const artifact = await build();
			const storageKey = `${prefix}/exports/${publicationId}/${format}`;
			await store.put(storageKey, Buffer.from(artifact.bytes), artifact.contentType);
			await db
				.insert(exportArtifacts)
				.values({
					publicationId,
					format,
					storageKey,
					filename: artifact.filename,
					contentType: artifact.contentType,
					byteSize: artifact.bytes.byteLength
				})
				.onConflictDoUpdate({
					target: [exportArtifacts.publicationId, exportArtifacts.format],
					set: {
						storageKey,
						filename: artifact.filename,
						contentType: artifact.contentType,
						byteSize: artifact.bytes.byteLength,
						createdAt: sql`now()`
					}
				});
			stored.push(format);
		} catch (error) {
			failed.push({ format, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return { ok: true, stored, failed };
}

export async function listEditionArtifacts(db: Database, publicationId: string) {
	return await db
		.select()
		.from(exportArtifacts)
		.where(eq(exportArtifacts.publicationId, publicationId))
		.orderBy(asc(exportArtifacts.format));
}

// Owner's toggle for reader-facing downloads on an edition.
export async function setDownloadsPublic(
	db: Database,
	userId: string,
	publicationId: string,
	value: boolean
): Promise<boolean> {
	const updated = await db
		.update(publications)
		.set({ downloadsPublic: value })
		.where(and(eq(publications.id, publicationId), eq(publications.ownerId, userId)))
		.returning({ id: publications.id });
	return updated.length > 0;
}

// Resolves an artifact for download, or null when the caller may not have
// it. The owner can always fetch their own artifacts; anyone else gets EPUB
// and PDF only, and only while the edition is current, readable, and has
// reader downloads switched on. The markdown zip is a backup format and
// stays owner-only. Mirrors the visibility rules of publicEdition.
export async function artifactForDownload(db: Database, artifactId: string, userId: string | null) {
	const [row] = await db
		.select({
			artifact: exportArtifacts,
			ownerId: publications.ownerId,
			isCurrent: publications.isCurrent,
			removedAt: publications.removedAt,
			downloadsPublic: publications.downloadsPublic,
			visibility: stories.visibility
		})
		.from(exportArtifacts)
		.innerJoin(publications, eq(exportArtifacts.publicationId, publications.id))
		.innerJoin(stories, eq(publications.storyId, stories.id))
		.where(eq(exportArtifacts.id, artifactId));
	if (!row) return null;
	if (userId && userId === row.ownerId) return row.artifact;
	const readable =
		row.isCurrent && !row.removedAt && row.visibility !== 'private' && row.downloadsPublic;
	if (readable && row.artifact.format !== 'markdown') return row.artifact;
	return null;
}
