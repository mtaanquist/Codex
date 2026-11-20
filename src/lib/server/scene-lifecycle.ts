import { and, asc, eq, inArray, isNotNull, sql, type SQL } from 'drizzle-orm';
import type { Database } from './auth.ts';
import {
	chapters,
	entityMentions,
	notes,
	reviewComments,
	reviewSuggestions,
	reviewThreads,
	revisions,
	sceneMarkers,
	scenes,
	stories
} from './db/schema.ts';
import type { EntityType } from './entity-lookups.ts';
import { keepTimestamps, keepUpdatedAt, ownedScene } from './scene-access.ts';
import { lockStoryChapters, lockStoryScenes } from './row-locks.ts';
import { storyIsLive } from './universe-scope.ts';

// Scene trash and chapter management. A deleted scene keeps its row (and its
// revisions, markers, and review threads) so restore is instant; only its
// mention rows go, since every panel reads those live. Delete forever removes
// everything the scene owns, mirroring the per-scene slice of story deletion.

async function ownedChapter(db: Database, userId: string, chapterId: string) {
	const [row] = await db
		.select({ id: chapters.id, storyId: chapters.storyId, position: chapters.position })
		.from(chapters)
		.innerJoin(stories, eq(chapters.storyId, stories.id))
		.where(and(eq(chapters.id, chapterId), eq(stories.ownerId, userId), storyIsLive()));
	return row ?? null;
}

/** Owner check by story id, for the create helpers that have no entity to
 * guard through yet. */
async function ownsStory(db: Database, userId: string, storyId: string): Promise<boolean> {
	const [row] = await db
		.select({ id: stories.id })
		.from(stories)
		.where(and(eq(stories.id, storyId), eq(stories.ownerId, userId), storyIsLive()));
	return Boolean(row);
}

/** Appends a chapter to the story, returning its id (null when the story is
 * not the user's). */
export async function createChapter(
	db: Database,
	userId: string,
	storyId: string
): Promise<string | null> {
	if (!(await ownsStory(db, userId, storyId))) return null;
	return await db.transaction(async (tx) => {
		// The story row, since a story with no chapters has none to lock: two
		// creates then take turns instead of reading the same maximum.
		await tx.execute(sql`select id from stories where id = ${storyId} for no key update`);
		const [chapter] = await tx
			.insert(chapters)
			.values({
				storyId,
				position: sql`(select coalesce(max(${chapters.position}), 0) + 1 from ${chapters} where ${chapters.storyId} = ${storyId})`
			})
			.returning({ id: chapters.id });
		return chapter.id;
	});
}

/** Appends a scene, to a chapter when one is given (and belongs to the story)
 * or to the unfiled list otherwise. Returns the new scene id, or null when the
 * story is not the user's or the chapter is not part of it. */
export async function createScene(
	db: Database,
	userId: string,
	storyId: string,
	chapterId: string | null = null
): Promise<string | null> {
	if (!(await ownsStory(db, userId, storyId))) return null;
	return await db.transaction(async (tx) => {
		// Before the maximum positions are read, so a split shifting scenes
		// finishes first and the new scene does not share a position with one.
		await lockStoryScenes(tx, storyId);
		if (chapterId) {
			const [chapter] = await tx
				.select({ id: chapters.id })
				.from(chapters)
				.where(and(eq(chapters.id, chapterId), eq(chapters.storyId, storyId)))
				.for('key share');
			if (!chapter) return null;
		}
		const [scene] = await tx
			.insert(scenes)
			.values({
				storyId,
				chapterId,
				positionInChapter: chapterId
					? sql`(select coalesce(max(${scenes.positionInChapter}), 0) + 1 from ${scenes} where ${scenes.chapterId} = ${chapterId})`
					: null,
				globalPosition: sql`(select coalesce(max(${scenes.globalPosition}), 0) + 1 from ${scenes} where ${scenes.storyId} = ${storyId})`
			})
			.returning({ id: scenes.id });
		return scene.id;
	});
}

/** Moves a scene to the story's trash. Mention rows go at once so panels and
 * the heatmap stop counting it; everything else stays for restore. */
export async function trashScene(db: Database, userId: string, sceneId: string): Promise<boolean> {
	const scene = await ownedScene(db, userId, sceneId);
	if (!scene) return false;
	await db.transaction(async (tx) => {
		await tx
			.update(scenes)
			.set({ deletedAt: sql`now()`, ...keepUpdatedAt() })
			.where(eq(scenes.id, scene.id));
		await markMentionsStale(tx, { sceneIds: [scene.id] });
		await tx
			.delete(entityMentions)
			.where(and(eq(entityMentions.sourceType, 'scene'), eq(entityMentions.sourceId, scene.id)));
	});
	return true;
}

/** A watermark before this is a mark set by markStale below, not a time an
 * arc was written or an entity read. */
export const STALE_MARK_BEFORE = new Date('2000-01-01T00:00:00Z');

/** Marks what these scenes (or this story's scenes) mention for
 * a fresh look: the characters' arcs show as out of date, and with `enrich` the
 * entities are read again on the next enrich pass. Call it before mention rows
 * are deleted, since it reads them. */
export async function markMentionsStale(
	tx: Database,
	source: { sceneIds: string[] } | { storyId: string },
	opts: { enrich?: boolean } = {}
): Promise<void> {
	if ('sceneIds' in source && !source.sceneIds.length) return;
	const from =
		'sceneIds' in source
			? sql`m.source_id in ${source.sceneIds}`
			: sql`m.source_id in (select id from scenes where story_id = ${source.storyId})`;
	await markStale(
		tx,
		(type) =>
			sql`(select m.target_id from entity_mentions m where m.source_type = 'scene' and m.target_type = ${type} and ${from})`,
		opts.enrich ?? false
	);
}

/** Marks these entities as markMentionsStale does, arcs and enrichment both
 * unless `enrich` is false: what the Assistant reads about them changed. */
export async function markEntitiesStale(
	tx: Database,
	targets: { targetType: EntityType; targetId: string }[],
	opts: { enrich?: boolean } = {}
): Promise<void> {
	await markStale(
		tx,
		(type) => {
			const ids = targets.filter((t) => t.targetType === type).map((t) => t.targetId);
			return ids.length ? sql`${ids}` : null;
		},
		opts.enrich ?? true
	);
}

// The mark is the clock fifty years back: older than any real watermark, and
// different each time, so a job that started from an earlier mark still sees a
// new one. `ids` gives the entities of a type to mark, or null for none.
async function markStale(
	tx: Database,
	ids: (type: EntityType) => SQL | null,
	enrich: boolean
): Promise<void> {
	const mark = sql`clock_timestamp() - interval '50 years'`;
	const characterIds = ids('character');
	const placeIds = enrich ? ids('place') : null;
	const loreIds = enrich ? ids('lore_entry') : null;
	// Lock every target lowest id first, table by table, before any update: an
	// update takes its rows in whatever order its plan meets them, so two marks
	// over the same entities could otherwise each hold a row the other needs.
	for (const [table, targets] of [
		['characters', characterIds],
		['places', placeIds],
		['lore_entries', loreIds]
	] as const) {
		if (targets) {
			await tx.execute(
				sql`select id from ${sql.identifier(table)} where id in ${targets} order by id for update`
			);
		}
	}
	if (characterIds) {
		await tx.execute(
			sql`update characters set arc_summary_at = ${mark} where id in ${characterIds}`
		);
	}
	if (!enrich) return;
	if (characterIds) {
		await tx.execute(
			sql`update characters set assistant_enriched_at = ${mark} where id in ${characterIds}`
		);
	}
	if (placeIds) {
		await tx.execute(
			sql`update places set assistant_enriched_at = ${mark} where id in ${placeIds}`
		);
	}
	if (loreIds) {
		await tx.execute(
			sql`update lore_entries set assistant_enriched_at = ${mark} where id in ${loreIds}`
		);
	}
}

/** Brings a scene back from the trash, at the end of its chapter (or of the
 * unfiled list when the chapter is gone). The caller queues the mention
 * rebuild; the reconcile sweep is the backstop. */
export async function restoreScene(
	db: Database,
	userId: string,
	sceneId: string
): Promise<boolean> {
	const scene = await ownedScene(db, userId, sceneId, { deleted: true });
	if (!scene) return false;
	return await db.transaction(async (tx) => {
		// Before the maximum positions are read, so a split shifting scenes
		// finishes first and the restored scene does not share a position.
		await lockStoryScenes(tx, scene.storyId);
		const [current] = await tx
			.select({ chapterId: scenes.chapterId, deletedAt: scenes.deletedAt })
			.from(scenes)
			.where(eq(scenes.id, scene.id));
		if (!current?.deletedAt) return false;
		// The chapter may have been deleted while the scene sat in the trash.
		// Key share keeps it from being deleted before the update lands.
		let chapterId = current.chapterId;
		if (chapterId) {
			const [chapter] = await tx
				.select({ id: chapters.id })
				.from(chapters)
				.where(eq(chapters.id, chapterId))
				.for('key share');
			if (!chapter) chapterId = null;
		}
		// Positions are renumbered wholesale on every reorder, so appending past
		// the current maximums is enough to avoid collisions. The trash cleared
		// the scene's mentions without touching its watermark, so the watermark
		// is cleared here: the reconcile sweep then rebuilds them if the queued
		// rebuild is lost.
		await tx
			.update(scenes)
			.set({
				...keepUpdatedAt(),
				mentionsIndexedAt: null,
				deletedAt: null,
				chapterId,
				positionInChapter: chapterId
					? sql`(select coalesce(max(${scenes.positionInChapter}), 0) + 1 from ${scenes} where ${scenes.chapterId} = ${chapterId} and ${scenes.deletedAt} is null)`
					: null,
				globalPosition: sql`(select coalesce(max(${scenes.globalPosition}), 0) + 1 from ${scenes} where ${scenes.storyId} = ${scene.storyId})`
			})
			.where(eq(scenes.id, scene.id));
		return true;
	});
}

/** Deletes a trashed scene for good: markers, mentions, revisions, review
 * threads and suggestions, then the row. Notes on the scene are detached. */
export async function destroyScene(
	db: Database,
	userId: string,
	sceneId: string
): Promise<boolean> {
	const scene = await ownedScene(db, userId, sceneId, { deleted: true });
	if (!scene) return false;
	await db.transaction(async (tx) => {
		// The scene row before its mentions, the order a mention rebuild takes.
		await tx.select({ id: scenes.id }).from(scenes).where(eq(scenes.id, scene.id)).for('update');
		// Threads before suggestions: a suggestion's discussion thread
		// references it.
		const threadRows = await tx
			.select({ id: reviewThreads.id })
			.from(reviewThreads)
			.where(eq(reviewThreads.sceneId, scene.id));
		if (threadRows.length > 0) {
			await tx.delete(reviewComments).where(
				inArray(
					reviewComments.threadId,
					threadRows.map((row) => row.id)
				)
			);
		}
		await tx.delete(reviewThreads).where(eq(reviewThreads.sceneId, scene.id));
		await tx.delete(reviewSuggestions).where(eq(reviewSuggestions.sceneId, scene.id));
		await tx.delete(sceneMarkers).where(eq(sceneMarkers.sceneId, scene.id));
		await tx
			.delete(entityMentions)
			.where(and(eq(entityMentions.sourceType, 'scene'), eq(entityMentions.sourceId, scene.id)));
		await tx.delete(revisions).where(eq(revisions.entityId, scene.id));
		// Notes on the scene are the writer's own words; keep them as story notes.
		await tx.update(notes).set({ sceneId: null }).where(eq(notes.sceneId, scene.id));
		await tx.delete(scenes).where(eq(scenes.id, scene.id));
	});
	return true;
}

export type TrashedScene = {
	id: string;
	title: string | null;
	wordCount: number;
	deletedAt: Date;
};

/** The story's trash, newest deletion first. */
export async function listTrashedScenes(db: Database, storyId: string): Promise<TrashedScene[]> {
	const rows = await db
		.select({
			id: scenes.id,
			title: scenes.title,
			wordCount: scenes.wordCount,
			deletedAt: scenes.deletedAt
		})
		.from(scenes)
		.where(and(eq(scenes.storyId, storyId), isNotNull(scenes.deletedAt)))
		.orderBy(sql`${scenes.deletedAt} desc`);
	return rows as TrashedScene[];
}

/** Owner-guarded chapter rename. An empty title clears back to "Chapter N". */
export async function renameChapter(
	db: Database,
	userId: string,
	chapterId: string,
	title: string
): Promise<boolean> {
	const chapter = await ownedChapter(db, userId, chapterId);
	if (!chapter) return false;
	await db
		.update(chapters)
		.set({ title: title.trim() || null })
		.where(eq(chapters.id, chapter.id));
	return true;
}

// Renumbering is not an edit to the chapter, so it leaves updated_at alone.
function keepChapterUpdatedAt() {
	return { updatedAt: sql`${chapters.updatedAt}` };
}

/** Swaps a chapter with its neighbour. A no-op at either end of the list. */
export async function moveChapter(
	db: Database,
	userId: string,
	chapterId: string,
	direction: 'up' | 'down'
): Promise<boolean> {
	const chapter = await ownedChapter(db, userId, chapterId);
	if (!chapter) return false;
	await db.transaction(async (tx) => {
		// The list is read under the locks, so a chapter created or deleted
		// meanwhile is counted.
		await tx.execute(sql`select id from stories where id = ${chapter.storyId} for no key update`);
		await lockStoryChapters(tx, chapter.storyId);
		const list = await tx
			.select({ id: chapters.id })
			.from(chapters)
			.where(eq(chapters.storyId, chapter.storyId))
			.orderBy(asc(chapters.position));
		const at = list.findIndex((row) => row.id === chapter.id);
		const to = direction === 'up' ? at - 1 : at + 1;
		if (at < 0 || to < 0 || to >= list.length) return;
		[list[at], list[to]] = [list[to], list[at]];
		// Renumber the whole list; stories are small enough that this costs
		// nothing and it keeps positions compact.
		for (const [index, row] of list.entries()) {
			await tx
				.update(chapters)
				.set({ position: index + 1, ...keepChapterUpdatedAt() })
				.where(eq(chapters.id, row.id));
		}
	});
	return true;
}

/** Deletes a chapter; its scenes (trashed ones included) become unfiled and
 * keep their place in the story order. Remaining chapters renumber. */
export async function deleteChapter(
	db: Database,
	userId: string,
	chapterId: string
): Promise<boolean> {
	const chapter = await ownedChapter(db, userId, chapterId);
	if (!chapter) return false;
	await db.transaction(async (tx) => {
		await lockStoryScenes(tx, chapter.storyId);
		await tx
			.update(scenes)
			.set({ chapterId: null, positionInChapter: null, ...keepTimestamps() })
			.where(eq(scenes.chapterId, chapter.id));
		await lockStoryChapters(tx, chapter.storyId);
		await tx.delete(chapters).where(eq(chapters.id, chapter.id));
		const rest = await tx
			.select({ id: chapters.id })
			.from(chapters)
			.where(eq(chapters.storyId, chapter.storyId))
			.orderBy(asc(chapters.position));
		for (const [index, row] of rest.entries()) {
			await tx
				.update(chapters)
				.set({ position: index + 1, ...keepChapterUpdatedAt() })
				.where(eq(chapters.id, row.id));
		}
	});
	return true;
}
