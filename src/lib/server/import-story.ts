import { eq } from 'drizzle-orm';
import type { Database } from './auth';
import {
	chapters,
	characters,
	characterStoryMemberships,
	characterStoryNotes,
	loreEntries,
	loreStoryNotes,
	places,
	placeStoryMemberships,
	placeStoryNotes,
	scenes,
	stories
} from './db/schema';
import { isUniqueViolation } from './db';
import { uniqueSlug } from './slugs';
import { wordCount } from '../word-count';
import { rewriteBundledAssetLinks, type ImportedNote, type ImportPlan } from '../import-markdown';
import { assetConfig, createAsset, s3AssetStore } from './assets';
import { createStoryEntity } from './create-entity';
import { queueUniverseMentions } from './jobs';
import { IMAGE_EXTENSIONS } from './media-types';

// Turns a parsed story zip into a new story in the chosen universe. The
// preview names every collision and how it will resolve; the commit follows
// exactly the rules the preview showed. Always a fresh story, never a merge.

type Universe = { id: string; ownerId: string };

export type NoteOutcome = 'match' | 'create' | 'ambiguous';
export type NoteResolution = ImportedNote & { outcome: NoteOutcome; entityId: string | null };

export type ImportPreview = {
	storyTitle: string;
	// A story with this exact title already exists in the universe; the
	// import still proceeds, as a second story.
	titleTaken: boolean;
	chapterCount: number;
	sceneCount: number;
	words: number;
	notes: { kind: ImportedNote['kind']; name: string; outcome: NoteOutcome }[];
	assetCount: number;
	assetsConfigured: boolean;
	problems: string[];
};

// Each note finds its entity by trimmed, case-insensitive name within its
// kind. One candidate attaches, none creates, two or more skips: picking one
// silently would be the only wrong answer.
async function resolveNotes(
	db: Database,
	universeId: string,
	notes: ImportedNote[]
): Promise<NoteResolution[]> {
	if (notes.length === 0) return [];
	const lists = {
		character: await db
			.select({ id: characters.id, name: characters.name })
			.from(characters)
			.where(eq(characters.universeId, universeId)),
		place: await db
			.select({ id: places.id, name: places.name })
			.from(places)
			.where(eq(places.universeId, universeId)),
		lore: await db
			.select({ id: loreEntries.id, name: loreEntries.title })
			.from(loreEntries)
			.where(eq(loreEntries.universeId, universeId))
	};
	const byName = (rows: { id: string; name: string }[]) => {
		const map = new Map<string, string[]>();
		for (const row of rows) {
			const key = row.name.trim().toLowerCase();
			map.set(key, [...(map.get(key) ?? []), row.id]);
		}
		return map;
	};
	const maps = {
		character: byName(lists.character),
		place: byName(lists.place),
		lore: byName(lists.lore)
	};
	return notes.map((note) => {
		const candidates = maps[note.kind].get(note.name.trim().toLowerCase()) ?? [];
		if (candidates.length === 1) return { ...note, outcome: 'match', entityId: candidates[0] };
		if (candidates.length === 0) return { ...note, outcome: 'create', entityId: null };
		return { ...note, outcome: 'ambiguous', entityId: null };
	});
}

export async function previewImport(
	db: Database,
	universe: Universe,
	plan: ImportPlan
): Promise<ImportPreview> {
	const allScenes = [...plan.chapters.flatMap((chapter) => chapter.scenes), ...plan.unfiled];
	const titleRows = await db
		.select({ title: stories.title })
		.from(stories)
		.where(eq(stories.universeId, universe.id));
	const resolutions = await resolveNotes(db, universe.id, plan.notes);
	return {
		storyTitle: plan.story.title,
		titleTaken: titleRows.some((row) => row.title === plan.story.title),
		chapterCount: plan.chapters.length,
		sceneCount: allScenes.length,
		words: allScenes.reduce((sum, scene) => sum + wordCount(scene.bodyMd), 0),
		notes: resolutions.map(({ kind, name, outcome }) => ({ kind, name, outcome })),
		assetCount: plan.assets.length,
		assetsConfigured: assetConfig() !== null,
		problems: plan.problems
	};
}

export type ImportResult = {
	storyId: string;
	slug: string;
	sceneCount: number;
	notesAttached: number;
	entitiesCreated: number;
	notesSkipped: number;
	problems: string[];
};

export async function runImport(
	db: Database,
	universe: Universe,
	plan: ImportPlan
): Promise<ImportResult> {
	const problems = [...plan.problems];

	// Assets first, outside the transaction: object storage is not
	// transactional anyway, and a failed import at worst leaves unreferenced
	// uploads. Each bundled file becomes a new asset; links rewrite to it.
	const assetLinks = new Map<string, string>();
	const config = assetConfig();
	if (config && plan.assets.length > 0) {
		const store = s3AssetStore(config);
		const typeOf = new Map(Object.entries(IMAGE_EXTENSIONS).map(([type, ext]) => [ext, type]));
		for (const asset of plan.assets) {
			const extension = asset.path.slice(asset.path.lastIndexOf('.') + 1).toLowerCase();
			const created = await createAsset(db, store, config, universe.ownerId, {
				universeId: universe.id,
				kind: 'inline',
				filename: asset.path,
				contentType: typeOf.get(extension) ?? 'application/octet-stream',
				bytes: Buffer.from(asset.bytes)
			});
			if (created.ok) {
				assetLinks.set(asset.id, `/assets/${created.id}`);
			} else {
				problems.push(`The image ${asset.path} could not be stored (${created.reason}).`);
			}
		}
	} else if (plan.assets.length > 0) {
		problems.push('Image storage is not configured; bundled images were not imported.');
	}
	const rewrite = (body: string) =>
		rewriteBundledAssetLinks(body, (id) => assetLinks.get(id) ?? null);

	const resolutions = await resolveNotes(db, universe.id, plan.notes);

	const insertStory = (slug: string) =>
		db
			.insert(stories)
			.values({
				universeId: universe.id,
				ownerId: universe.ownerId,
				title: plan.story.title,
				author: plan.story.author,
				brief: plan.story.brief,
				descriptionMd: rewrite(plan.story.descriptionMd) || null,
				slug
			})
			.returning({ id: stories.id, slug: stories.slug });
	let story;
	try {
		[story] = await insertStory(
			await uniqueSlug(db, 'stories', universe.ownerId, plan.story.title, 'story')
		);
	} catch (err) {
		// A concurrent create took the slug between the pick and the insert.
		if (!isUniqueViolation(err)) throw err;
		[story] = await insertStory(
			await uniqueSlug(db, 'stories', universe.ownerId, plan.story.title, 'story')
		);
	}

	let sceneCount = 0;
	let notesAttached = 0;
	let entitiesCreated = 0;
	let notesSkipped = 0;

	await db.transaction(async (tx) => {
		let globalPosition = 0;
		const insertScene = async (
			scene: ImportPlan['unfiled'][number],
			chapterId: string | null,
			positionInChapter: number | null
		) => {
			const bodyMd = rewrite(scene.bodyMd);
			globalPosition += 1;
			sceneCount += 1;
			await tx.insert(scenes).values({
				storyId: story.id,
				chapterId,
				positionInChapter,
				globalPosition,
				title: scene.title,
				bodyMd,
				status: scene.status ?? 'draft',
				wordCount: wordCount(bodyMd)
			});
		};

		for (const [chapterIndex, chapter] of plan.chapters.entries()) {
			const [row] = await tx
				.insert(chapters)
				.values({ storyId: story.id, title: chapter.title, position: chapterIndex + 1 })
				.returning({ id: chapters.id });
			for (const [sceneIndex, scene] of chapter.scenes.entries()) {
				await insertScene(scene, row.id, sceneIndex + 1);
			}
		}
		for (const scene of plan.unfiled) {
			await insertScene(scene, null, null);
		}

		for (const note of resolutions) {
			let entityId = note.entityId;
			if (note.outcome === 'ambiguous') {
				notesSkipped += 1;
				problems.push(
					`${note.name}: more than one ${note.kind === 'lore' ? 'lore entry' : note.kind} shares this name; the note was skipped.`
				);
				continue;
			}
			if (note.outcome === 'create') {
				const created = await createStoryEntity(
					tx,
					{ universeId: universe.id, ownerId: universe.ownerId, storyId: story.id },
					note.kind === 'lore' ? 'lore_entry' : note.kind,
					note.name
				);
				if (!created.ok) {
					notesSkipped += 1;
					problems.push(`${note.name}: could not be created (${created.reason}); note skipped.`);
					continue;
				}
				entityId = created.id;
				entitiesCreated += 1;
			} else if (note.kind === 'character') {
				await tx
					.insert(characterStoryMemberships)
					.values({ characterId: entityId!, storyId: story.id })
					.onConflictDoNothing();
			} else if (note.kind === 'place') {
				await tx
					.insert(placeStoryMemberships)
					.values({ placeId: entityId!, storyId: story.id })
					.onConflictDoNothing();
			}
			const notesMd = rewrite(note.notesMd);
			if (note.kind === 'character') {
				await tx
					.insert(characterStoryNotes)
					.values({ characterId: entityId!, storyId: story.id, notesMd });
			} else if (note.kind === 'place') {
				await tx.insert(placeStoryNotes).values({ placeId: entityId!, storyId: story.id, notesMd });
			} else {
				await tx
					.insert(loreStoryNotes)
					.values({ loreEntryId: entityId!, storyId: story.id, notesMd });
			}
			notesAttached += 1;
		}
	});

	// One universe-wide rebuild covers every imported scene.
	await queueUniverseMentions(universe.id);

	return {
		storyId: story.id,
		slug: story.slug,
		sceneCount,
		notesAttached,
		entitiesCreated,
		notesSkipped,
		problems
	};
}
