import { strToU8, zipSync, type Zippable } from 'fflate';
import { slugify } from '../slug.ts';
import { and, asc, eq, isNull, ne } from 'drizzle-orm';
import type { Database } from './auth';
import {
	assets,
	chapters,
	characters,
	characterStoryNotes,
	entityCategories,
	entityRelationships,
	loreEntries,
	loreStoryNotes,
	places,
	placeStoryNotes,
	relationTypes,
	scenes,
	stories,
	universes
} from './db/schema.ts';
import { findAssetReferences, rewriteAssetReferences } from '../markdown.ts';
import { assetConfig, s3AssetStore } from './assets.ts';
import { extensionFor } from './media-types.ts';
import { namesByType, type EntityType } from './entity-lookups.ts';

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
// A story-scoped note overlay on a universe entity. The id only seeds the
// filename slug when the name does not.
export type ExportNote = {
	id: string;
	kind: 'character' | 'place' | 'lore';
	name: string;
	notesMd: string;
};
export type StoryContent = {
	chapters: { id: string; title: string | null }[];
	scenes: ExportScene[];
	// Absent for frozen editions: notes are working material, not manuscript.
	notes?: ExportNote[];
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
	return { chapters: chapterList, scenes: sceneList, notes: await gatherStoryNotes(db, story.id) };
}

async function gatherStoryNotes(db: Database, storyId: string): Promise<ExportNote[]> {
	const characterNotes = await db
		.select({ id: characters.id, name: characters.name, notesMd: characterStoryNotes.notesMd })
		.from(characterStoryNotes)
		.innerJoin(characters, eq(characterStoryNotes.characterId, characters.id))
		.where(and(eq(characterStoryNotes.storyId, storyId), ne(characterStoryNotes.notesMd, '')))
		.orderBy(asc(characters.name));
	const placeNotes = await db
		.select({ id: places.id, name: places.name, notesMd: placeStoryNotes.notesMd })
		.from(placeStoryNotes)
		.innerJoin(places, eq(placeStoryNotes.placeId, places.id))
		.where(and(eq(placeStoryNotes.storyId, storyId), ne(placeStoryNotes.notesMd, '')))
		.orderBy(asc(places.name));
	const loreNotes = await db
		.select({ id: loreEntries.id, name: loreEntries.title, notesMd: loreStoryNotes.notesMd })
		.from(loreStoryNotes)
		.innerJoin(loreEntries, eq(loreStoryNotes.loreEntryId, loreEntries.id))
		.where(and(eq(loreStoryNotes.storyId, storyId), ne(loreStoryNotes.notesMd, '')))
		.orderBy(asc(loreEntries.title));
	return [
		...characterNotes.map((note) => ({ ...note, kind: 'character' as const })),
		...placeNotes.map((note) => ({ ...note, kind: 'place' as const })),
		...loreNotes.map((note) => ({ ...note, kind: 'lore' as const }))
	];
}

// Subdirectory per note kind, matching the universe archive's layout.
const NOTE_DIRS = { character: 'characters', place: 'places', lore: 'lore' } as const;

export async function buildStoryZip(
	story: ExportStory,
	content: StoryContent,
	loadAssets: AssetLoader
): Promise<{ filename: string; bytes: Uint8Array }> {
	const { chapters: chapterList, scenes: sceneList, notes: noteList = [] } = content;

	const referenced = [
		...new Set([
			...sceneList.flatMap((scene) => findAssetReferences(scene.bodyMd)),
			...noteList.flatMap((note) => findAssetReferences(note.notesMd))
		])
	];
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

	for (const note of noteList) {
		const dir = `notes/${NOTE_DIRS[note.kind]}`;
		const up = '../'.repeat(dir.split('/').length);
		const body = rewriteAssetReferences(note.notesMd, (id) =>
			assetPath.has(id) ? `${up}${assetPath.get(id)}` : `/assets/${id}`
		);
		files[`${root}/${dir}/${slugify(note.name, note.id)}.md`] = strToU8(
			frontMatter({ name: note.name, kind: note.kind }) + body
		);
	}

	for (const asset of loaded) {
		files[`${root}/${assetPath.get(asset.id)!}`] = asset.bytes;
	}

	return { filename: `${root}.zip`, bytes: zipSync(files) };
}

// One document destined for the account archive, gathered before any assets
// are loaded so references can be rewritten in a second pass. Docs without
// front matter (relationships, reviews) carry their heading in the body.
type Doc = {
	dir: string;
	name: string;
	front?: Record<string, string | string[] | null | undefined>;
	body: string;
	coverId?: string | null;
};

// Review threads for the account export, gathered by an injected loader so
// the review module (whose import closure is not worker-safe) stays out of
// this file's; the worker imports the builders for edition artifacts.
export type ExportReviewThread = {
	sceneTitle: string | null;
	resolved: boolean;
	// The text the thread points at in the current scene body; null for
	// whole-scene comments and for anchors that no longer fit.
	excerpt: string | null;
	anchorLost: boolean;
	comments: { authorName: string; isOwner: boolean; createdAt: Date; body: string }[];
};
export type ReviewLoader = (storyId: string) => Promise<ExportReviewThread[]>;

function reviewsMarkdown(threads: ExportReviewThread[]): string {
	const lines = ['# Review feedback', ''];
	for (const thread of threads) {
		const state = thread.resolved ? 'resolved' : 'open';
		lines.push(`## ${thread.sceneTitle ?? 'Untitled scene'} (${state})`, '');
		if (thread.excerpt) {
			for (const excerptLine of thread.excerpt.split('\n')) lines.push(`> ${excerptLine}`);
		} else if (thread.anchorLost) {
			lines.push('> The text this thread pointed at has since changed.');
		} else {
			lines.push('> On the whole scene.');
		}
		lines.push('');
		for (const comment of thread.comments) {
			const role = comment.isOwner ? 'author' : 'reviewer';
			const date = comment.createdAt.toISOString().slice(0, 10);
			lines.push(`${comment.authorName} (${role}), ${date}:`, '', comment.body.trim(), '');
		}
	}
	return lines.join('\n');
}

// Everything one account owns, as a single markdown archive: every universe
// with its characters, places, lore, and relationships, and every story's
// chapters, scenes, and story notes, with referenced images and covers
// bundled and links rewritten. This is the "export first" safety net before
// account deletion, so review feedback rides along when a loader is given.
export async function buildAccountExport(
	db: Database,
	userId: string,
	loadAssets: AssetLoader,
	loadReviews?: ReviewLoader
): Promise<{ filename: string; bytes: Uint8Array }> {
	const docs: Doc[] = [];
	const universeList = await db
		.select()
		.from(universes)
		.where(and(eq(universes.ownerId, userId), isNull(universes.deletedAt)))
		.orderBy(asc(universes.createdAt));

	for (const universe of universeList) {
		const uDir = `universes/${slugify(universe.name, universe.id)}`;
		docs.push(...(await gatherUniverseDocs(db, universe, uDir, loadReviews)));
	}
	return packDocs(docs, loadAssets, 'codex-export.zip');
}

/** One universe's archive: characters/, places/, lore/, and a folder per
 * story, rooted at the top of the zip. */
export async function buildUniverseExport(
	db: Database,
	universe: typeof universes.$inferSelect,
	loadAssets: AssetLoader
): Promise<{ filename: string; bytes: Uint8Array }> {
	const docs = await gatherUniverseDocs(db, universe, '.');
	return packDocs(docs, loadAssets, `${slugify(universe.name, universe.id)}.zip`);
}

async function gatherUniverseDocs(
	db: Database,
	universe: typeof universes.$inferSelect,
	uDir: string,
	loadReviews?: ReviewLoader
): Promise<Doc[]> {
	const docs: Doc[] = [];
	{
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
			const {
				chapters: chapterList,
				scenes: sceneList,
				notes: noteList = []
			} = await gatherStory(db, story);
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
			for (const note of noteList) {
				docs.push({
					dir: `${sDir}/notes/${NOTE_DIRS[note.kind]}`,
					name: `${slugify(note.name, note.id)}.md`,
					front: { name: note.name, kind: note.kind },
					body: note.notesMd
				});
			}
			if (loadReviews) {
				const threads = await loadReviews(story.id);
				if (threads.length > 0) {
					docs.push({ dir: sDir, name: 'reviews.md', body: reviewsMarkdown(threads) });
				}
			}
		}

		const relationshipsMd = await gatherRelationships(db, universe.id);
		if (relationshipsMd) {
			docs.push({ dir: uDir, name: 'relationships.md', body: relationshipsMd });
		}
	}
	return docs;
}

// Every relationship in the universe, once each in its forward direction,
// as one readable markdown list.
async function gatherRelationships(db: Database, universeId: string): Promise<string | null> {
	const rows = await db
		.select({
			fromType: entityRelationships.fromType,
			fromId: entityRelationships.fromId,
			toType: entityRelationships.toType,
			toId: entityRelationships.toId,
			notesMd: entityRelationships.notesMd,
			label: relationTypes.forwardLabel
		})
		.from(entityRelationships)
		.innerJoin(relationTypes, eq(entityRelationships.relationTypeId, relationTypes.id))
		.where(and(eq(entityRelationships.universeId, universeId), isNull(entityRelationships.storyId)))
		.orderBy(asc(relationTypes.sortOrder), asc(entityRelationships.createdAt));
	if (rows.length === 0) return null;

	const names: Record<EntityType, Map<string, string>> = {
		character: new Map(),
		place: new Map(),
		lore_entry: new Map()
	};
	for (const type of ['character', 'place', 'lore_entry'] as const) {
		const ids = [
			...new Set(
				rows.flatMap((row) => [
					...(row.fromType === type ? [row.fromId] : []),
					...(row.toType === type ? [row.toId] : [])
				])
			)
		];
		names[type] = await namesByType(db, type, ids);
	}

	const kindLabel: Record<EntityType, string> = {
		character: 'character',
		place: 'place',
		lore_entry: 'lore'
	};
	const side = (type: string, id: string) => {
		const entityType = type as EntityType;
		return `${names[entityType].get(id) ?? 'Unknown'} (${kindLabel[entityType]})`;
	};
	const lines = ['# Relationships', ''];
	for (const row of rows) {
		lines.push(
			`- ${side(row.fromType, row.fromId)} - ${row.label} - ${side(row.toType, row.toId)}`
		);
		const note = row.notesMd?.trim();
		if (note) for (const noteLine of note.split('\n')) lines.push(`  ${noteLine}`);
	}
	return lines.join('\n') + '\n';
}

async function packDocs(
	docs: Doc[],
	loadAssets: AssetLoader,
	filename: string
): Promise<{ filename: string; bytes: Uint8Array }> {
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
		// A '.' base (the single-universe export) roots files at the top of
		// the zip; drop it from paths and depth alike.
		const parts = doc.dir.split('/').filter((part) => part && part !== '.');
		const up = '../'.repeat(parts.length);
		const linkFor = (id: string) =>
			assetPath.has(id) ? `${up}${assetPath.get(id)}` : `/assets/${id}`;
		let head = '';
		if (doc.front) {
			const front = { ...doc.front };
			if (doc.coverId && assetPath.has(doc.coverId)) front.cover = linkFor(doc.coverId);
			head = frontMatter(front);
		}
		files[[...parts, doc.name].join('/')] = strToU8(
			head + rewriteAssetReferences(doc.body, linkFor)
		);
	}
	for (const asset of loaded) {
		files[assetPath.get(asset.id)!] = asset.bytes;
	}
	if (docs.length === 0)
		files['README.md'] = strToU8('# Codex export\n\nThere is no content here yet.\n');

	return { filename, bytes: zipSync(files) };
}

function joinBody(summaryMd: string | null, bodyMd: string): string {
	return [summaryMd?.trim(), bodyMd.trim()].filter(Boolean).join('\n\n');
}
