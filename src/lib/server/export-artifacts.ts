import { existsSync } from 'node:fs';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Database } from './auth.ts';
import { exportArtifacts, publications, stories } from './db/schema.ts';
import { effectiveAssetConfig, s3AssetStore, type AssetObjectStore } from './assets.ts';
import {
	asBuffer,
	bucketAssetLoader,
	buildStoryZip,
	cachedAssetLoader,
	readAssets,
	type AssetLoader,
	type ExportAsset,
	type ExportStory,
	type StoryContent
} from './export.ts';
import { slugify } from '../slug.ts';
import { uploadZip, type ZipArchive } from './zip-stream.ts';
import { buildEpub } from './epub.ts';
import type { EditionContent } from './publish.ts';
import { findAssetReferences, renderMarkdown, rewriteAssetReferences } from '../markdown.ts';
import { DEFAULT_PAGE_SETUP, pageCss, pdfRenderOptions, type PageSetup } from '../page-setup.ts';
import { storyPageSetup } from './page-setup.ts';

// Stored export artifacts: when an edition publishes, the worker generates
// its markdown zip, EPUB, and PDF from the frozen content and keeps them in
// the asset bucket, the way a release carries assets. Everything here is
// derived data; regeneration overwrites in place. Runs in the worker.

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

// A complete print-ready HTML document for the PDF renderer, styled by the
// page setup (#lib/page-setup builds the stylesheet the browser print route
// shares). Page geometry rides the pdf options instead of an @page rule,
// since Chromium's header/footer layer needs it there. Images are inlined
// as data URIs; any other image URL is blocked by the renderer (isolatePage).
export function buildEditionHtml(
	meta: { title: string; author: string | null },
	content: StoryContent,
	images: Map<string, ExportAsset>,
	setup: PageSetup = DEFAULT_PAGE_SETUP
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
<head><meta charset="utf-8"/><title>${escapeHtml(meta.title)}</title><style>${pageCss(setup, { includePageRule: true })}</style></head>
<body>
<header class="title-page"><h1>${escapeHtml(meta.title)}</h1>${
		meta.author ? `<p class="author">${escapeHtml(meta.author)}</p>` : ''
	}</header>
${sections.join('\n')}
</body>
</html>`;
}

export function chromiumPath(): string | null {
	if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
	for (const path of ['/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome']) {
		if (existsSync(path)) return path;
	}
	return null;
}

type IsolatablePage = {
	setJavaScriptEnabled(enabled: boolean): Promise<void>;
	setRequestInterception(enabled: boolean): Promise<void>;
	on(
		event: 'request',
		handler: (request: { url(): string; continue(): Promise<void>; abort(): Promise<void> }) => void
	): unknown;
};

// The rendered HTML carries author content, and markdown still turns an
// external image URL into an <img>. Every request other than an inlined
// data: URI is aborted, so the worker's browser never reaches the network
// it runs in (internal services, cloud metadata endpoints). Scripts are off
// as well; nothing in the document needs them.
export async function isolatePage(page: IsolatablePage): Promise<void> {
	await page.setJavaScriptEnabled(false);
	await page.setRequestInterception(true);
	page.on('request', (request) => {
		if (request.url().startsWith('data:')) void request.continue();
		else void request.abort();
	});
}

// Renders the document with headless Chromium via puppeteer-core, driving
// the system browser (installed in the Docker image and found by
// chromiumPath; CHROMIUM_PATH points elsewhere when needed). Loaded lazily so nothing outside the worker's PDF
// path pays for it.
export async function renderEditionPdf(
	html: string,
	options: Record<string, unknown> = {
		format: 'a4',
		margin: { top: '2cm', bottom: '2cm', left: '2cm', right: '2cm' }
	}
): Promise<Uint8Array> {
	const executablePath = chromiumPath();
	if (!executablePath) {
		throw new Error('no Chromium found; set CHROMIUM_PATH or install the chromium package');
	}
	const { launch } = await import('puppeteer-core');
	const browser = await launch({
		executablePath,
		// Puppeteer gives up after 30s by default, and a cold start on a busy
		// host (a CI runner mid-suite) has run past that.
		timeout: 90_000,
		// Sandboxing is off because the container already isolates the process,
		// the rendered HTML is built from author prose with raw HTML escaped, and
		// isolatePage blocks scripts and every network request. The dead proxy
		// (loopback included) backs that up for fetches interception does not
		// see, such as <link rel=prefetch>.
		args: [
			'--no-sandbox',
			'--disable-setuid-sandbox',
			'--disable-dev-shm-usage',
			'--disable-gpu',
			'--proxy-server=127.0.0.1:9',
			'--proxy-bypass-list=<-loopback>'
		]
	});
	try {
		const page = await browser.newPage();
		await isolatePage(page);
		await page.setContent(html, { waitUntil: 'load' });
		const pdf = await page.pdf(options);
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
	renderPdf?: (html: string, options?: Record<string, unknown>) => Promise<Uint8Array>;
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
	const config = await effectiveAssetConfig(db);
	if (!config && !(deps.store && deps.prefix !== undefined)) {
		return { ok: false, reason: 'File storage is not set up on this server.' };
	}
	const prefix = deps.prefix ?? config!.prefix;
	const store = deps.store ?? s3AssetStore(config!);

	const [edition] = await db
		.select({
			id: publications.id,
			storyId: publications.storyId,
			title: publications.title,
			author: publications.author,
			descriptionMd: publications.descriptionMd,
			content: publications.content,
			removedAt: publications.removedAt,
			coverAssetId: stories.coverAssetId,
			ownerId: stories.ownerId
		})
		.from(publications)
		.innerJoin(stories, eq(publications.storyId, stories.id))
		.where(eq(publications.id, publicationId));
	if (!edition) return { ok: false, reason: 'That edition no longer exists.' };
	if (edition.removedAt) return { ok: false, reason: 'That edition was taken down.' };

	// Formatting is not content: artifacts always typeset with the current
	// page setup, so "Generate again" picks up setup changes without a new
	// edition.
	const setup = await storyPageSetup(db, edition.storyId);

	const story: ExportStory = {
		id: edition.id,
		title: edition.title,
		author: edition.author,
		brief: null,
		descriptionMd: edition.descriptionMd
	};
	const content = editionStoryContent(edition.content as EditionContent);
	// The three formats share one set of images, fetched from the bucket once.
	const loadAssets = cachedAssetLoader(deps.loadAssets ?? bucketAssetLoader(db, edition.ownerId));
	const renderPdf = deps.renderPdf ?? renderEditionPdf;
	const slug = slugify(edition.title, 'story');

	// The zip and EPUB stream into the bucket as they are written; the PDF
	// comes back from the browser whole.
	type Built = { contentType: string } & (ZipArchive | { filename: string; bytes: Uint8Array });
	const builders: { format: ArtifactFormat; build: () => Promise<Built> }[] = [
		{
			format: 'markdown',
			build: async () => ({
				...(await buildStoryZip(story, content, loadAssets)),
				contentType: 'application/zip'
			})
		},
		{
			format: 'epub',
			build: async () => ({
				...(await buildEpub(story, content, loadAssets, edition.coverAssetId, setup)),
				contentType: 'application/epub+zip'
			})
		},
		{
			format: 'pdf',
			build: async () => {
				const referenced = [
					...new Set(content.scenes.flatMap((scene) => findAssetReferences(scene.bodyMd)))
				];
				const loaded = await readAssets(await loadAssets(referenced));
				const images = new Map(loaded.map((asset) => [asset.id, asset]));
				const html = buildEditionHtml(
					{ title: edition.title, author: edition.author },
					content,
					images,
					setup
				);
				return {
					filename: `${slug}.pdf`,
					bytes: await renderPdf(html, pdfRenderOptions(setup, edition.title)),
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
			let byteSize: number;
			if ('entries' in artifact) {
				byteSize = await uploadZip(store, storageKey, artifact.entries, artifact.contentType);
			} else {
				await store.put(storageKey, asBuffer(artifact.bytes), artifact.contentType);
				byteSize = artifact.bytes.byteLength;
			}
			await db
				.insert(exportArtifacts)
				.values({
					publicationId,
					format,
					storageKey,
					filename: artifact.filename,
					contentType: artifact.contentType,
					byteSize
				})
				.onConflictDoUpdate({
					target: [exportArtifacts.publicationId, exportArtifacts.format],
					set: {
						storageKey,
						filename: artifact.filename,
						contentType: artifact.contentType,
						byteSize,
						createdAt: sql`now()`
					}
				});
			stored.push(format);
		} catch (error) {
			failed.push({ format, error: error instanceof Error ? error.message : String(error) });
		}
	}
	// Persist the failures so the owner's settings page can show which downloads
	// could not be built and why, instead of the failure only reaching the log.
	await db
		.update(publications)
		.set({ artifactErrors: failed })
		.where(eq(publications.id, publicationId));
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
			visibility: stories.visibility,
			storyDeletedAt: stories.deletedAt
		})
		.from(exportArtifacts)
		.innerJoin(publications, eq(exportArtifacts.publicationId, publications.id))
		.innerJoin(stories, eq(publications.storyId, stories.id))
		.where(eq(exportArtifacts.id, artifactId));
	if (!row) return null;
	if (userId && userId === row.ownerId) return row.artifact;
	const readable =
		row.isCurrent &&
		!row.removedAt &&
		!row.storyDeletedAt &&
		row.visibility !== 'private' &&
		row.downloadsPublic;
	if (readable && row.artifact.format !== 'markdown') return row.artifact;
	return null;
}
