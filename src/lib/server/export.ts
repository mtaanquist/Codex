import { strToU8, zipSync, type Zippable } from 'fflate';
import { asc, eq } from 'drizzle-orm';
import type { Database } from './auth';
import { assets, chapters, scenes } from './db/schema';
import { findAssetReferences, rewriteAssetReferences } from '$lib/markdown';
import { assetConfig, s3AssetStore } from './assets';

// Story export: a zip of markdown files with YAML front matter, in
// chapter order, with referenced images bundled into assets/ and the
// links rewritten. Markdown in, markdown out; nothing is trapped.

export function slugify(text: string | null, fallback: string): string {
	const slug = (text ?? '')
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60);
	return slug || fallback;
}

function frontMatter(fields: Record<string, string | null | undefined>): string {
	const lines = ['---'];
	for (const [key, value] of Object.entries(fields)) {
		if (value === null || value === undefined || value === '') continue;
		lines.push(`${key}: ${JSON.stringify(value)}`);
	}
	lines.push('---', '');
	return lines.join('\n');
}

const EXTENSIONS: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/webp': 'webp',
	'image/gif': 'gif',
	'image/avif': 'avif'
};

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

export async function gatherStory(db: Database, story: ExportStory) {
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
		.where(eq(scenes.storyId, story.id))
		.orderBy(asc(scenes.globalPosition));
	return { chapters: chapterList, scenes: sceneList };
}

export async function buildStoryZip(
	db: Database,
	story: ExportStory,
	loadAssets: AssetLoader
): Promise<{ filename: string; bytes: Uint8Array }> {
	const { chapters: chapterList, scenes: sceneList } = await gatherStory(db, story);

	const referenced = [...new Set(sceneList.flatMap((scene) => findAssetReferences(scene.bodyMd)))];
	const loaded = await loadAssets(referenced);
	const assetPath = new Map(
		loaded.map((asset) => [
			asset.id,
			`assets/${asset.id}.${EXTENSIONS[asset.contentType] ?? 'bin'}`
		])
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
