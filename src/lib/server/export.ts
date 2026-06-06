import { strToU8, zipSync, type Zippable } from 'fflate';
import { slugify } from '../slug.ts';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Database } from './auth';
import {
	assets,
	chapters,
	characters,
	entityCategories,
	loreEntries,
	places,
	scenes,
	stories,
	universes
} from './db/schema.ts';
import { findAssetReferences, rewriteAssetReferences } from '../markdown.ts';
import { assetConfig, s3AssetStore } from './assets.ts';
import { extensionFor } from './media-types.ts';

// Story export: a zip of markdown files with YAML front matter, in
// chapter order, with referenced images bundled into assets/ and the
// links rewritten. Markdown in, markdown out; nothing is trapped.
// Runs in the worker too (artifact generation), so relative value imports
// carry explicit .ts extensions and avoid the $lib alias.

function frontMatter(fields: Record<string, string | string[] | null | undefined>): string {
	const lines = ['---'];
	for (const [key, value] of Object.entries(fields)) {
		if (value === null || value === undefined || value === '') continue;
		if (Array.isArray(value)) {
			if (value.length === 0) continue;
			lines.push(`${key}:`);
			for (const item of value) lines.push(`  - ${JSON.stringify(item)}`);
			continue;
		}
		lines.push(`${key}: ${JSON.stringify(value)}`);
	}
	lines.push('---', '');
	return lines.join('\n');
}

// Quick details flatten to "Label: value" lines in the front matter list.
function detailLines(details: { label: string; value: string }[]): string[] {
	return details.map((detail) => `${detail.label}: ${detail.value}`);
}

export type ExportAsset = { id: string; contentType: string; bytes: Uint8Array };
export type AssetLoader = (ids: string[]) => Promise<ExportAsset[]>;

// The default loader reads from the configured bucket; absent
// configuration it returns nothing and links stay as app paths.
export function bucketAssetLoader(db: Database): AssetLoader {
	return async (ids) => {
		const config = assetConfig();
		if (!config || ids.length === 0) return [];
		const store = s3AssetStore(config);
		const loaded: ExportAsset[] = [];
		for (const id of ids) {
			const [row] = await db.select().from(assets).where(eq(assets.id, id));
			if (!row) continue;
			const chunks: Buffer[] = [];
			for await (const chunk of await store.get(row.storageKey)) {
				chunks.push(Buffer.from(chunk));
			}
			loaded.push({ id, contentType: row.contentType, bytes: Buffer.concat(chunks) });
		}
		return loaded;
	};
}

export type ExportStory = {
	id: string;
	title: string;
	author: string | null;
	brief: string | null;
	descriptionMd: string | null;
};

// The content the builders consume: a live story gathered from the database,
// or a published edition's frozen prose converted to the same shape. Keeping
// the builders pure over this lets both paths share them.
export type ExportScene = {
	// Present for live scenes; frozen editions do not carry scene ids.
	id?: string;
	chapterId: string | null;
	title: string | null;
	status?: string | null;
	bodyMd: string;
};
export type StoryContent = {
	chapters: { id: string; title: string | null }[];
	scenes: ExportScene[];
};

export async function gatherStory(db: Database, story: ExportStory): Promise<StoryContent> {
	const chapterList = await db
		.select({ id: chapters.id, title: chapters.title })
		.from(chapters)
		.where(eq(chapters.storyId, story.id))
		.orderBy(asc(chapters.position));
	const sceneList = await db
		.select({
			id: scenes.id,
			chapterId: scenes.chapterId,
			title: scenes.title,
			status: scenes.status,
			bodyMd: scenes.bodyMd
		})
		.from(scenes)
		.where(and(eq(scenes.storyId, story.id), isNull(scenes.deletedAt)))
		.orderBy(asc(scenes.globalPosition));
	return { chapters: chapterList, scenes: sceneList };
}

export async function buildStoryZip(
	story: ExportStory,
	content: StoryContent,
	loadAssets: AssetLoader
): Promise<{ filename: string; bytes: Uint8Array }> {
	const { chapters: chapterList, scenes: sceneList } = content;

	const referenced = [...new Set(sceneList.flatMap((scene) => findAssetReferences(scene.bodyMd)))];
	const loaded = await loadAssets(referenced);
	const assetPath = new Map(
		loaded.map((asset) => [asset.id, `assets/${asset.id}.${extensionFor(asset.contentType)}`])
	);

	const root = slugify(story.title, 'story');
	const files: Zippable = {};
	files[`${root}/story.md`] = strToU8(
		frontMatter({ title: story.title, author: story.author, brief: story.brief }) +
			(story.descriptionMd ?? '')
	);

	const sceneFile = (scene: (typeof sceneList)[number], index: number, dir: string) => {
		const name = `${String(index + 1).padStart(2, '0')}-${slugify(scene.title, 'scene')}.md`;
		// Bundled assets get relative links; unbundled ones keep app paths.
		const up = '../'.repeat(dir.split('/').length);
		const body = rewriteAssetReferences(scene.bodyMd, (id) =>
			assetPath.has(id) ? `${up}${assetPath.get(id)}` : `/assets/${id}`
		);
		files[`${root}/${dir}/${name}`] = strToU8(
			frontMatter({ title: scene.title, status: scene.status }) + body
		);
	};

	chapterList.forEach((chapter, chapterIndex) => {
		const dir = `chapters/${String(chapterIndex + 1).padStart(2, '0')}-${slugify(chapter.title, 'chapter')}`;
		sceneList
			.filter((scene) => scene.chapterId === chapter.id)
			.forEach((scene, sceneIndex) => sceneFile(scene, sceneIndex, dir));
	});
	sceneList
		.filter((scene) => scene.chapterId === null)
		.forEach((scene, sceneIndex) => sceneFile(scene, sceneIndex, 'unfiled'));

	for (const asset of loaded) {
		files[`${root}/${assetPath.get(asset.id)!}`] = asset.bytes;
	}

	return { filename: `${root}.zip`, bytes: zipSync(files) };
}

// One document destined for the account archive, gathered before any assets
// are loaded so references can be rewritten in a second pass.
type Doc = {
	dir: string;
	name: string;
	front: Record<string, string | string[] | null | undefined>;
	body: string;
	coverId?: string | null;
};

// Everything one account owns, as a single markdown archive: every universe
// with its characters, places, and lore, and every story's chapters and
// scenes, with referenced images and covers bundled and links rewritten. This
// is the "export first" safety net before account deletion. Story-scoped note
// overlays are not yet included (the universe-level entries are).
export async function buildAccountExport(
	db: Database,
	userId: string,
	loadAssets: AssetLoader
): Promise<{ filename: string; bytes: Uint8Array }> {
	const docs: Doc[] = [];
	const universeList = await db
		.select()
		.from(universes)
		.where(eq(universes.ownerId, userId))
		.orderBy(asc(universes.createdAt));

	for (const universe of universeList) {
		const uDir = `universes/${slugify(universe.name, universe.id)}`;
		docs.push({
			dir: uDir,
			name: 'universe.md',
			front: { name: universe.name },
			body: universe.descriptionMd ?? ''
		});

		const categories = new Map(
			(
				await db
					.select({ id: entityCategories.id, name: entityCategories.name })
					.from(entityCategories)
					.where(eq(entityCategories.universeId, universe.id))
			).map((c) => [c.id, c.name])
		);
		const categoryName = (id: string | null) => (id ? (categories.get(id) ?? null) : null);

		const characterList = await db
			.select()
			.from(characters)
			.where(eq(characters.universeId, universe.id))
			.orderBy(asc(characters.name));
		for (const c of characterList) {
			docs.push({
				dir: `${uDir}/characters`,
				name: `${slugify(c.name, c.id)}.md`,
				front: {
					name: c.name,
					aliases: c.aliases.length ? c.aliases.join(', ') : null,
					category: categoryName(c.categoryId),
					details: detailLines(c.details)
				},
				body: joinBody(c.summaryMd, c.bodyMd)
			});
		}

		const placeList = await db
			.select()
			.from(places)
			.where(eq(places.universeId, universe.id))
			.orderBy(asc(places.name));
		for (const p of placeList) {
			docs.push({
				dir: `${uDir}/places`,
				name: `${slugify(p.name, p.id)}.md`,
				front: {
					name: p.name,
					category: categoryName(p.categoryId),
					details: detailLines(p.details)
				},
				body: joinBody(p.summaryMd, p.bodyMd)
			});
		}

		const loreList = await db
			.select()
			.from(loreEntries)
			.where(eq(loreEntries.universeId, universe.id))
			.orderBy(asc(loreEntries.title));
		for (const l of loreList) {
			docs.push({
				dir: `${uDir}/lore`,
				name: `${slugify(l.title, l.id)}.md`,
				front: {
					title: l.title,
					keywords: l.keywords.length ? l.keywords.join(', ') : null,
					category: categoryName(l.categoryId),
					details: detailLines(l.details)
				},
				body: joinBody(l.summaryMd, l.bodyMd)
			});
		}

		const storyList = await db
			.select()
			.from(stories)
			.where(eq(stories.universeId, universe.id))
			.orderBy(asc(stories.positionInSeries), asc(stories.createdAt));
		for (const story of storyList) {
			const sDir = `${uDir}/stories/${slugify(story.title, story.id)}`;
			docs.push({
				dir: sDir,
				name: 'story.md',
				front: { title: story.title, author: story.author, brief: story.brief },
				body: story.descriptionMd ?? '',
				coverId: story.coverAssetId
			});
			const { chapters: chapterList, scenes: sceneList } = await gatherStory(db, story);
			const addScene = (scene: (typeof sceneList)[number], index: number, dir: string) => {
				docs.push({
					dir,
					name: `${String(index + 1).padStart(2, '0')}-${slugify(scene.title, 'scene')}.md`,
					front: { title: scene.title, status: scene.status },
					body: scene.bodyMd
				});
			};
			chapterList.forEach((chapter, ci) => {
				const dir = `${sDir}/chapters/${String(ci + 1).padStart(2, '0')}-${slugify(chapter.title, 'chapter')}`;
				sceneList
					.filter((s) => s.chapterId === chapter.id)
					.forEach((s, si) => addScene(s, si, dir));
			});
			sceneList
				.filter((s) => s.chapterId === null)
				.forEach((s, si) => addScene(s, si, `${sDir}/unfiled`));
		}
	}

	// Collect every referenced and cover asset, load once, then write each doc
	// with links rewritten relative to its own depth.
	const referenced = new Set<string>();
	for (const doc of docs) {
		findAssetReferences(doc.body).forEach((id) => referenced.add(id));
		if (doc.coverId) referenced.add(doc.coverId);
	}
	const loaded = await loadAssets([...referenced]);
	const assetPath = new Map(
		loaded.map((a) => [a.id, `assets/${a.id}.${extensionFor(a.contentType)}`])
	);

	const files: Zippable = {};
	for (const doc of docs) {
		const up = '../'.repeat(doc.dir.split('/').filter(Boolean).length);
		const linkFor = (id: string) =>
			assetPath.has(id) ? `${up}${assetPath.get(id)}` : `/assets/${id}`;
		const front = { ...doc.front };
		if (doc.coverId && assetPath.has(doc.coverId)) front.cover = linkFor(doc.coverId);
		files[`${doc.dir}/${doc.name}`] = strToU8(
			frontMatter(front) + rewriteAssetReferences(doc.body, linkFor)
		);
	}
	for (const asset of loaded) {
		files[assetPath.get(asset.id)!] = asset.bytes;
	}
	if (docs.length === 0)
		files['README.md'] = strToU8('# Codex export\n\nThis account has no content yet.\n');

	return { filename: 'codex-export.zip', bytes: zipSync(files) };
}

function joinBody(summaryMd: string | null, bodyMd: string): string {
	return [summaryMd?.trim(), bodyMd.trim()].filter(Boolean).join('\n\n');
}
