import { and, asc, eq, inArray, isNull, isNotNull, sql } from 'drizzle-orm';
import type { Database } from './auth';
import {
	chapters,
	entityMentions,
	reviewComments,
	reviewSuggestions,
	reviewThreads,
	revisions,
	sceneMarkers,
	scenes,
	stories
} from './db/schema';

// Scene trash and chapter management. A deleted scene keeps its row (and its
// revisions, markers, and review threads) so restore is instant; only its
// mention rows go, since every panel reads those live. Delete forever removes
// everything the scene owns, mirroring the per-scene slice of story deletion.

async function ownedScene(db: Database, userId: string, sceneId: string, deleted: boolean) {
	const [row] = await db
		.select({ id: scenes.id, storyId: scenes.storyId, chapterId: scenes.chapterId })
		.from(scenes)
		.innerJoin(stories, eq(scenes.storyId, stories.id))
		.where(
			and(
				eq(scenes.id, sceneId),
				eq(stories.ownerId, userId),
				deleted ? isNotNull(scenes.deletedAt) : isNull(scenes.deletedAt)
			)
		);
	return row ?? null;
}

async function ownedChapter(db: Database, userId: string, chapterId: string) {
	const [row] = await db
		.select({ id: chapters.id, storyId: chapters.storyId, position: chapters.position })
		.from(chapters)
		.innerJoin(stories, eq(chapters.storyId, stories.id))
		.where(and(eq(chapters.id, chapterId), eq(stories.ownerId, userId)));
	return row ?? null;
}

/** Moves a scene to the story's trash. Mention rows go at once so panels and
 * the heatmap stop counting it; everything else stays for restore. */
export async function trashScene(db: Database, userId: string, sceneId: string): Promise<boolean> {
	const scene = await ownedScene(db, userId, sceneId, false);
	if (!scene) return false;
	await db.transaction(async (tx) => {
		await tx
			.update(scenes)
			.set({ deletedAt: sql`now()` })
			.where(eq(scenes.id, scene.id));
		await tx
			.delete(entityMentions)
			.where(and(eq(entityMentions.sourceType, 'scene'), eq(entityMentions.sourceId, scene.id)));
	});
	return true;
}

/** Brings a scene back from the trash, at the end of its chapter (or of the
 * unfiled list when the chapter is gone). The caller queues the mention
 * rebuild; the reconcile sweep is the backstop. */
export async function restoreScene(
	db: Database,
	userId: string,
	sceneId: string
): Promise<boolean> {
	const scene = await ownedScene(db, userId, sceneId, true);
	if (!scene) return false;
	await db.transaction(async (tx) => {
		// The chapter may have been deleted while the scene sat in the trash.
		let chapterId = scene.chapterId;
		if (chapterId) {
			const [chapter] = await tx
				.select({ id: chapters.id })
				.from(chapters)
				.where(eq(chapters.id, chapterId));
			if (!chapter) chapterId = null;
		}
		// Positions are renumbered wholesale on every reorder, so appending past
		// the current maximums is enough to avoid collisions.
		await tx
			.update(scenes)
			.set({
				deletedAt: null,
				chapterId,
				positionInChapter: chapterId
					? sql`(select coalesce(max(${scenes.positionInChapter}), 0) + 1 from ${scenes} where ${scenes.chapterId} = ${chapterId} and ${scenes.deletedAt} is null)`
					: null,
				globalPosition: sql`(select coalesce(max(${scenes.globalPosition}), 0) + 1 from ${scenes} where ${scenes.storyId} = ${scene.storyId})`
			})
			.where(eq(scenes.id, scene.id));
	});
	return true;
}

/** Deletes a trashed scene for good: markers, mentions, revisions, review
 * threads and suggestions, then the row. */
export async function destroyScene(
	db: Database,
	userId: string,
	sceneId: string
): Promise<boolean> {
	const scene = await ownedScene(db, userId, sceneId, true);
	if (!scene) return false;
	await db.transaction(async (tx) => {
		await tx.delete(reviewSuggestions).where(eq(reviewSuggestions.sceneId, scene.id));
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
		await tx.delete(sceneMarkers).where(eq(sceneMarkers.sceneId, scene.id));
		await tx
			.delete(entityMentions)
			.where(and(eq(entityMentions.sourceType, 'scene'), eq(entityMentions.sourceId, scene.id)));
		await tx.delete(revisions).where(eq(revisions.entityId, scene.id));
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

/** Swaps a chapter with its neighbour. A no-op at either end of the list. */
export async function moveChapter(
	db: Database,
	userId: string,
	chapterId: string,
	direction: 'up' | 'down'
): Promise<boolean> {
	const chapter = await ownedChapter(db, userId, chapterId);
	if (!chapter) return false;
	const list = await db
		.select({ id: chapters.id })
		.from(chapters)
		.where(eq(chapters.storyId, chapter.storyId))
		.orderBy(asc(chapters.position));
	const at = list.findIndex((row) => row.id === chapter.id);
	const to = direction === 'up' ? at - 1 : at + 1;
	if (to < 0 || to >= list.length) return true;
	[list[at], list[to]] = [list[to], list[at]];
	// Renumber the whole list; stories are small enough that this costs nothing
	// and it keeps positions compact.
	await db.transaction(async (tx) => {
		for (const [index, row] of list.entries()) {
			await tx
				.update(chapters)
				.set({ position: index + 1 })
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
		await tx
			.update(scenes)
			.set({ chapterId: null, positionInChapter: null })
			.where(eq(scenes.chapterId, chapter.id));
		await tx.delete(chapters).where(eq(chapters.id, chapter.id));
		const rest = await tx
			.select({ id: chapters.id })
			.from(chapters)
			.where(eq(chapters.storyId, chapter.storyId))
			.orderBy(asc(chapters.position));
		for (const [index, row] of rest.entries()) {
			await tx
				.update(chapters)
				.set({ position: index + 1 })
				.where(eq(chapters.id, row.id));
		}
	});
	return true;
}
