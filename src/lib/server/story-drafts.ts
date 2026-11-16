import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Database } from './auth.ts';
import {
	chapters,
	characters,
	characterStoryMemberships,
	characterStoryNotes,
	entityCategories,
	entityRelationships,
	loreEntries,
	loreStoryNotes,
	notes,
	places,
	placeStoryMemberships,
	placeStoryNotes,
	relationTypes,
	scenes,
	stories,
	storyDrafts
} from './db/schema.ts';
import type { ActionFailure } from './action-result.ts';
import { recordRevision } from './revisions.ts';
import { remapMarkerAnchors } from './markers.ts';
import { uniqueSlug } from './slugs.ts';
import { isUniqueViolation } from './db-errors.ts';
import { wordCount } from '#lib/word-count';
import {
	DRAFT_LABEL_MAX,
	DRAFT_NOTE_MAX,
	draftOutline,
	type DraftContent,
	type DraftEntity,
	type DraftEntityType
} from '#lib/drafts';

// Saved drafts: private, frozen copies of a whole story. Saving one reads
// everything in one repeatable-read transaction, so the copy is a single
// consistent moment. Nothing here ever writes over the working draft without
// a new revision on top (restoring a scene), and a draft's content is never
// changed after it is saved; only its label and note are.

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type StoryRow = typeof stories.$inferSelect;

export type DraftSummary = {
	id: string;
	label: string;
	noteMd: string | null;
	wordCount: number;
	createdAt: Date;
};

const NOT_FOUND: ActionFailure = {
	ok: false,
	code: 'not_found',
	reason: 'That saved draft no longer exists.'
};

function cleanLabel(raw: string): string | ActionFailure {
	const label = raw.trim();
	if (!label) return { ok: false, code: 'invalid', reason: 'Give the draft a name.' };
	if (label.length > DRAFT_LABEL_MAX) {
		return {
			ok: false,
			code: 'invalid',
			reason: `Keep the name under ${DRAFT_LABEL_MAX} characters.`
		};
	}
	return label;
}

function cleanNote(raw: string): string | null | ActionFailure {
	const note = raw.trim();
	if (note.length > DRAFT_NOTE_MAX) {
		return {
			ok: false,
			code: 'invalid',
			reason: `Keep the note under ${DRAFT_NOTE_MAX} characters.`
		};
	}
	return note || null;
}

// Everything the draft freezes, read through one connection. The caller
// runs it inside a repeatable-read transaction.
export async function buildDraftContent(tx: Tx | Database, story: StoryRow): Promise<DraftContent> {
	const chapterRows = await tx
		.select({ id: chapters.id, title: chapters.title, summaryMd: chapters.summaryMd })
		.from(chapters)
		.where(eq(chapters.storyId, story.id))
		.orderBy(asc(chapters.position));
	const sceneRows = await tx
		.select({
			id: scenes.id,
			chapterId: scenes.chapterId,
			title: scenes.title,
			bodyMd: scenes.bodyMd,
			summaryMd: scenes.summaryMd,
			status: scenes.status,
			storyTime: scenes.storyTime,
			wordCount: scenes.wordCount
		})
		.from(scenes)
		.where(and(eq(scenes.storyId, story.id), isNull(scenes.deletedAt)))
		.orderBy(asc(scenes.globalPosition));

	const categoryRows = await tx
		.select({ id: entityCategories.id, name: entityCategories.name })
		.from(entityCategories)
		.where(eq(entityCategories.universeId, story.universeId));
	const categoryName = new Map(categoryRows.map((row) => [row.id, row.name]));

	const [characterRows, placeRows, loreRows] = [
		await tx
			.select({
				id: characters.id,
				name: characters.name,
				aliases: characters.aliases,
				categoryId: characters.categoryId,
				summaryMd: characters.summaryMd,
				bodyMd: characters.bodyMd,
				details: characters.details,
				storyNotesMd: characterStoryNotes.notesMd,
				inStory: sql<boolean>`${characterStoryMemberships.storyId} is not null`
			})
			.from(characters)
			.leftJoin(
				characterStoryNotes,
				and(
					eq(characterStoryNotes.characterId, characters.id),
					eq(characterStoryNotes.storyId, story.id)
				)
			)
			.leftJoin(
				characterStoryMemberships,
				and(
					eq(characterStoryMemberships.characterId, characters.id),
					eq(characterStoryMemberships.storyId, story.id)
				)
			)
			.where(eq(characters.universeId, story.universeId))
			.orderBy(asc(characters.name)),
		await tx
			.select({
				id: places.id,
				name: places.name,
				aliases: places.aliases,
				categoryId: places.categoryId,
				summaryMd: places.summaryMd,
				bodyMd: places.bodyMd,
				details: places.details,
				storyNotesMd: placeStoryNotes.notesMd,
				inStory: sql<boolean>`${placeStoryMemberships.storyId} is not null`
			})
			.from(places)
			.leftJoin(
				placeStoryNotes,
				and(eq(placeStoryNotes.placeId, places.id), eq(placeStoryNotes.storyId, story.id))
			)
			.leftJoin(
				placeStoryMemberships,
				and(
					eq(placeStoryMemberships.placeId, places.id),
					eq(placeStoryMemberships.storyId, story.id)
				)
			)
			.where(eq(places.universeId, story.universeId))
			.orderBy(asc(places.name)),
		await tx
			.select({
				id: loreEntries.id,
				name: loreEntries.title,
				aliases: loreEntries.keywords,
				categoryId: loreEntries.categoryId,
				summaryMd: loreEntries.summaryMd,
				bodyMd: loreEntries.bodyMd,
				details: loreEntries.details,
				storyNotesMd: loreStoryNotes.notesMd,
				// Lore has no membership table; a story note is what ties it here.
				inStory: sql<boolean>`${loreStoryNotes.id} is not null`
			})
			.from(loreEntries)
			.leftJoin(
				loreStoryNotes,
				and(eq(loreStoryNotes.loreEntryId, loreEntries.id), eq(loreStoryNotes.storyId, story.id))
			)
			.where(eq(loreEntries.universeId, story.universeId))
			.orderBy(asc(loreEntries.title))
	];
	const toEntity =
		(type: DraftEntityType) =>
		(row: (typeof characterRows)[number]): DraftEntity => ({
			type,
			id: row.id,
			name: row.name,
			aliases: row.aliases,
			categoryName: row.categoryId ? (categoryName.get(row.categoryId) ?? null) : null,
			summaryMd: row.summaryMd,
			bodyMd: row.bodyMd,
			details: row.details,
			storyNotesMd: row.storyNotesMd?.trim() ? row.storyNotesMd : null,
			inStory: Boolean(row.inStory)
		});

	const relationshipRows = await tx
		.select({
			fromType: entityRelationships.fromType,
			fromId: entityRelationships.fromId,
			toType: entityRelationships.toType,
			toId: entityRelationships.toId,
			label: relationTypes.forwardLabel,
			notesMd: entityRelationships.notesMd,
			storyId: entityRelationships.storyId
		})
		.from(entityRelationships)
		.innerJoin(relationTypes, eq(entityRelationships.relationTypeId, relationTypes.id))
		.where(
			and(
				eq(entityRelationships.universeId, story.universeId),
				or(isNull(entityRelationships.storyId), eq(entityRelationships.storyId, story.id))
			)
		)
		.orderBy(asc(relationTypes.sortOrder), asc(entityRelationships.createdAt));

	const noteRows = await tx
		.select({
			id: notes.id,
			title: notes.title,
			bodyMd: notes.bodyMd,
			pinned: notes.pinned,
			sceneId: notes.sceneId
		})
		.from(notes)
		.where(eq(notes.storyId, story.id))
		.orderBy(asc(notes.createdAt));

	return {
		version: 1,
		story: {
			title: story.title,
			author: story.author,
			brief: story.brief,
			descriptionMd: story.descriptionMd,
			coverAssetId: story.coverAssetId
		},
		chapters: chapterRows,
		scenes: sceneRows,
		entities: [
			...characterRows.map(toEntity('character')),
			...placeRows.map(toEntity('place')),
			...loreRows.map(toEntity('lore_entry'))
		],
		relationships: relationshipRows.map(({ storyId, ...row }) => ({
			...row,
			storyOnly: storyId !== null
		})),
		notes: noteRows
	};
}

// Saves the story as it stands now under a name. The story row is read
// inside the transaction too, so its title and cover match the prose.
export async function saveDraft(
	db: Database,
	userId: string,
	storyId: string,
	input: { label: string; note: string }
): Promise<{ ok: true; id: string } | ActionFailure> {
	const label = cleanLabel(input.label);
	if (typeof label !== 'string') return label;
	const note = cleanNote(input.note);
	if (note !== null && typeof note !== 'string') return note;
	return await db.transaction(
		async (tx) => {
			const [story] = await tx
				.select()
				.from(stories)
				.where(and(eq(stories.id, storyId), eq(stories.ownerId, userId)));
			if (!story) {
				return { ok: false as const, code: 'not_found' as const, reason: 'That story is gone.' };
			}
			const content = await buildDraftContent(tx, story);
			const words = content.scenes.reduce((sum, scene) => sum + scene.wordCount, 0);
			const [row] = await tx
				.insert(storyDrafts)
				.values({ storyId, ownerId: userId, label, noteMd: note, content, wordCount: words })
				.returning({ id: storyDrafts.id });
			return { ok: true as const, id: row.id };
		},
		{ isolationLevel: 'repeatable read' }
	);
}

export async function listDrafts(db: Database, storyId: string): Promise<DraftSummary[]> {
	return db
		.select({
			id: storyDrafts.id,
			label: storyDrafts.label,
			noteMd: storyDrafts.noteMd,
			wordCount: storyDrafts.wordCount,
			createdAt: storyDrafts.createdAt
		})
		.from(storyDrafts)
		.where(eq(storyDrafts.storyId, storyId))
		.orderBy(desc(storyDrafts.createdAt));
}

// Every saved draft the user has, by story, for the library's cover menus.
export async function draftsByStory(
	db: Database,
	userId: string
): Promise<Map<string, { id: string; label: string }[]>> {
	const rows = await db
		.select({ id: storyDrafts.id, storyId: storyDrafts.storyId, label: storyDrafts.label })
		.from(storyDrafts)
		.where(eq(storyDrafts.ownerId, userId))
		.orderBy(desc(storyDrafts.createdAt));
	const byStory = new Map<string, { id: string; label: string }[]>();
	for (const row of rows) {
		const list = byStory.get(row.storyId) ?? [];
		list.push({ id: row.id, label: row.label });
		byStory.set(row.storyId, list);
	}
	return byStory;
}

export async function getDraft(db: Database, storyId: string, draftId: string) {
	const [row] = await db
		.select()
		.from(storyDrafts)
		.where(and(eq(storyDrafts.id, draftId), eq(storyDrafts.storyId, storyId)));
	return row ?? null;
}

export async function updateDraftDetails(
	db: Database,
	storyId: string,
	draftId: string,
	input: { label: string; note: string }
): Promise<{ ok: true } | ActionFailure> {
	const label = cleanLabel(input.label);
	if (typeof label !== 'string') return label;
	const note = cleanNote(input.note);
	if (note !== null && typeof note !== 'string') return note;
	const updated = await db
		.update(storyDrafts)
		.set({ label, noteMd: note })
		.where(and(eq(storyDrafts.id, draftId), eq(storyDrafts.storyId, storyId)))
		.returning({ id: storyDrafts.id });
	return updated.length > 0 ? { ok: true } : NOT_FOUND;
}

export async function deleteDraft(
	db: Database,
	storyId: string,
	draftId: string
): Promise<{ ok: true } | ActionFailure> {
	const deleted = await db
		.delete(storyDrafts)
		.where(and(eq(storyDrafts.id, draftId), eq(storyDrafts.storyId, storyId)))
		.returning({ id: storyDrafts.id });
	return deleted.length > 0 ? { ok: true } : NOT_FOUND;
}

// Whether any saved draft still shows this image as its cover, so replacing
// the cover keeps the old file for the draft.
export async function draftUsesCover(
	db: Database,
	storyId: string,
	assetId: string
): Promise<boolean> {
	const [row] = await db
		.select({ id: storyDrafts.id })
		.from(storyDrafts)
		.where(
			and(
				eq(storyDrafts.storyId, storyId),
				sql`${storyDrafts.content} -> 'story' ->> 'coverAssetId' = ${assetId}`
			)
		)
		.limit(1);
	return Boolean(row);
}

// The scenes.metadata key on a scene added back from a saved draft: the id
// the scene had when the draft was saved.
export const FROM_DRAFT_SCENE = 'fromDraftScene';

// Puts one scene's saved text back into the working draft. The live scene's
// current text is kept in History first, and the restored text lands as a
// new revision on top, so the step can be undone from History. When the
// scene has since been deleted, a new scene is made with the saved title and
// text instead (in its old chapter when that still exists); a trashed scene
// is left where it is.
export async function restoreDraftScene(
	db: Database,
	storyId: string,
	draftId: string,
	sceneId: string
): Promise<{ ok: true; sceneId: string; created: boolean } | ActionFailure> {
	const draft = await getDraft(db, storyId, draftId);
	if (!draft) return NOT_FOUND;
	const saved = draft.content.scenes.find((scene) => scene.id === sceneId);
	if (!saved) {
		return { ok: false, code: 'not_found', reason: 'That scene is not in this draft.' };
	}
	const label = `From the saved draft "${draft.label}"`;
	return await db.transaction(async (tx) => {
		const [live] = await tx
			.select({ id: scenes.id, bodyMd: scenes.bodyMd })
			.from(scenes)
			.where(and(eq(scenes.id, sceneId), eq(scenes.storyId, storyId), isNull(scenes.deletedAt)))
			.for('update');
		if (live) {
			if (live.bodyMd !== saved.bodyMd) {
				await recordRevision(tx, 'scene', live.id, live.bodyMd, 'checkpoint', {
					label: `Before restoring from "${draft.label}"`
				});
				await tx
					.update(scenes)
					.set({ bodyMd: saved.bodyMd, wordCount: wordCount(saved.bodyMd) })
					.where(eq(scenes.id, live.id));
				await remapMarkerAnchors(tx, live.id, live.bodyMd, saved.bodyMd);
				await recordRevision(tx, 'scene', live.id, saved.bodyMd, 'restore', { label });
			}
			return { ok: true as const, sceneId: live.id, created: false };
		}
		// Added back once already: the copy has a new id and remembers the
		// saved scene it came from. The lock keeps a double submit from making
		// two copies.
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtext(${`draft-restore:${storyId}:${sceneId}`}))`
		);
		const [copy] = await tx
			.select({ id: scenes.id })
			.from(scenes)
			.where(
				and(
					eq(scenes.storyId, storyId),
					isNull(scenes.deletedAt),
					sql`${scenes.metadata} ->> ${FROM_DRAFT_SCENE} = ${sceneId}`
				)
			)
			.limit(1);
		if (copy) return { ok: true as const, sceneId: copy.id, created: false };
		const [chapter] = saved.chapterId
			? await tx
					.select({ id: chapters.id })
					.from(chapters)
					.where(and(eq(chapters.id, saved.chapterId), eq(chapters.storyId, storyId)))
			: [];
		const chapterId = chapter?.id ?? null;
		const [created] = await tx
			.insert(scenes)
			.values({
				storyId,
				chapterId,
				positionInChapter: chapterId
					? sql`(select coalesce(max(${scenes.positionInChapter}), 0) + 1 from ${scenes} where ${scenes.chapterId} = ${chapterId})`
					: null,
				globalPosition: sql`(select coalesce(max(${scenes.globalPosition}), 0) + 1 from ${scenes} where ${scenes.storyId} = ${storyId})`,
				title: saved.title,
				bodyMd: saved.bodyMd,
				summaryMd: saved.summaryMd,
				status: saved.status as (typeof scenes.$inferInsert)['status'],
				storyTime: saved.storyTime,
				wordCount: wordCount(saved.bodyMd),
				metadata: { [FROM_DRAFT_SCENE]: sceneId }
			})
			.returning({ id: scenes.id });
		await recordRevision(tx, 'scene', created.id, saved.bodyMd, 'restore', { label });
		return { ok: true as const, sceneId: created.id, created: true };
	});
}

// Makes a new story in the same universe from a saved draft: its chapters,
// scenes, notes, and this story's notes on characters, places, and lore that
// still exist. The universe's worldbuilding itself is shared and stays as it
// is now. The original story is not touched.
export async function newStoryFromDraft(
	db: Database,
	userId: string,
	story: StoryRow,
	draftId: string,
	title: string
): Promise<{ ok: true; slug: string } | ActionFailure> {
	const draft = await getDraft(db, story.id, draftId);
	if (!draft) return NOT_FOUND;
	const name = title.trim().slice(0, 200) || `${draft.content.story.title} (${draft.label})`;
	const content = draft.content;
	const outline = draftOutline(content);
	// A concurrent create can take the picked slug between the pick and the
	// insert; the whole copy then rolls back and tries once more.
	try {
		return await copy(await uniqueSlug(db, 'stories', userId, name, 'story'));
	} catch (err) {
		if (!isUniqueViolation(err)) throw err;
		return await copy(await uniqueSlug(db, 'stories', userId, name, 'story'));
	}

	async function copy(slug: string) {
		return await db.transaction(async (tx) => {
			const [created] = await tx
				.insert(stories)
				.values({
					universeId: story.universeId,
					ownerId: userId,
					title: name,
					slug,
					author: content.story.author,
					brief: content.story.brief,
					descriptionMd: content.story.descriptionMd,
					styleNotes: story.styleNotes,
					isAdult: story.isAdult,
					coverColor: story.coverColor
				})
				.returning({ id: stories.id, slug: stories.slug });

			const sceneIds = new Map<string, string>();
			let globalPosition = 0;
			const insertScene = async (
				scene: DraftContent['scenes'][number],
				chapterId: string | null,
				positionInChapter: number | null
			) => {
				globalPosition += 1;
				const [row] = await tx
					.insert(scenes)
					.values({
						storyId: created.id,
						chapterId,
						positionInChapter,
						globalPosition,
						title: scene.title,
						bodyMd: scene.bodyMd,
						summaryMd: scene.summaryMd,
						storyTime: scene.storyTime,
						status: scene.status as (typeof scenes.$inferInsert)['status'],
						wordCount: wordCount(scene.bodyMd)
					})
					.returning({ id: scenes.id });
				sceneIds.set(scene.id, row.id);
			};
			for (const [index, chapter] of outline.chapters.entries()) {
				const [row] = await tx
					.insert(chapters)
					.values({
						storyId: created.id,
						title: chapter.title,
						summaryMd: chapter.summaryMd,
						position: index + 1
					})
					.returning({ id: chapters.id });
				for (const [sceneIndex, scene] of chapter.scenes.entries()) {
					await insertScene(scene, row.id, sceneIndex + 1);
				}
			}
			for (const scene of outline.unfiled) await insertScene(scene, null, null);

			for (const note of content.notes) {
				await tx.insert(notes).values({
					ownerId: userId,
					universeId: story.universeId,
					storyId: created.id,
					sceneId: note.sceneId ? (sceneIds.get(note.sceneId) ?? null) : null,
					title: note.title,
					bodyMd: note.bodyMd,
					pinned: note.pinned
				});
			}

			// Story notes and memberships only for entities that still exist.
			const ids = (type: DraftEntityType) =>
				content.entities.filter((entity) => entity.type === type).map((entity) => entity.id);
			const alive = async (type: DraftEntityType): Promise<Set<string>> => {
				const wanted = ids(type);
				if (wanted.length === 0) return new Set();
				const table = type === 'character' ? characters : type === 'place' ? places : loreEntries;
				const rows = await tx
					.select({ id: table.id })
					.from(table)
					.where(and(inArray(table.id, wanted), eq(table.universeId, story.universeId)));
				return new Set(rows.map((row) => row.id));
			};
			const living = {
				character: await alive('character'),
				place: await alive('place'),
				lore_entry: await alive('lore_entry')
			};
			for (const entity of content.entities) {
				if (!living[entity.type].has(entity.id)) continue;
				if (entity.type === 'character') {
					if (entity.inStory) {
						await tx
							.insert(characterStoryMemberships)
							.values({ characterId: entity.id, storyId: created.id });
					}
					if (entity.storyNotesMd) {
						await tx.insert(characterStoryNotes).values({
							characterId: entity.id,
							storyId: created.id,
							notesMd: entity.storyNotesMd
						});
					}
				} else if (entity.type === 'place') {
					if (entity.inStory) {
						await tx
							.insert(placeStoryMemberships)
							.values({ placeId: entity.id, storyId: created.id });
					}
					if (entity.storyNotesMd) {
						await tx
							.insert(placeStoryNotes)
							.values({ placeId: entity.id, storyId: created.id, notesMd: entity.storyNotesMd });
					}
				} else if (entity.storyNotesMd) {
					await tx.insert(loreStoryNotes).values({
						loreEntryId: entity.id,
						storyId: created.id,
						notesMd: entity.storyNotesMd
					});
				}
			}
			return { ok: true as const, slug: created.slug };
		});
	}
}
