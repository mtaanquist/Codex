import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Database } from './auth';
import { sceneMarkers, scenes, stories } from './db/schema';
import { findTodoLines } from '$lib/todo-markers';

// Loads a scene with an ownership check through its story.
async function ownedScene(db: Database, sceneId: string, userId: string) {
	const [row] = await db
		.select({ id: scenes.id, bodyMd: scenes.bodyMd, storyId: scenes.storyId })
		.from(scenes)
		.innerJoin(stories, eq(scenes.storyId, stories.id))
		.where(and(eq(scenes.id, sceneId), eq(stories.ownerId, userId)));
	return row ?? null;
}

// A selection turned into a checkable marker. Anchors are clamped to the
// scene body so a stale client cannot write ranges past the end.
export async function createMarker(
	db: Database,
	userId: string,
	sceneId: string,
	anchorStart: number,
	anchorEnd: number,
	bodyMd?: string
): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
	const scene = await ownedScene(db, sceneId, userId);
	if (!scene) return { ok: false, reason: 'scene not found' };
	const length = scene.bodyMd.length;
	const start = Math.max(0, Math.min(anchorStart, length));
	const end = Math.max(start, Math.min(anchorEnd, length));
	if (end === start) return { ok: false, reason: 'select some text to mark' };
	const [marker] = await db
		.insert(sceneMarkers)
		.values({
			sceneId,
			ownerId: userId,
			anchorStart: start,
			anchorEnd: end,
			bodyMd: bodyMd?.trim() || null
		})
		.returning({ id: sceneMarkers.id });
	return { ok: true, id: marker.id };
}

export async function setMarkerResolved(
	db: Database,
	userId: string,
	markerId: string,
	resolved: boolean
): Promise<boolean> {
	const updated = await db
		.update(sceneMarkers)
		.set({ resolvedAt: resolved ? new Date() : null })
		.where(and(eq(sceneMarkers.id, markerId), eq(sceneMarkers.ownerId, userId)))
		.returning({ id: sceneMarkers.id });
	return updated.length > 0;
}

export async function deleteMarker(
	db: Database,
	userId: string,
	markerId: string
): Promise<boolean> {
	const deleted = await db
		.delete(sceneMarkers)
		.where(and(eq(sceneMarkers.id, markerId), eq(sceneMarkers.ownerId, userId)))
		.returning({ id: sceneMarkers.id });
	return deleted.length > 0;
}

// The editor maps anchors through edits; the autosave persists where they
// landed. Only the scene's own markers can move.
export async function updateMarkerAnchors(
	db: Database,
	sceneId: string,
	anchors: { id: string; anchorStart: number; anchorEnd: number }[]
): Promise<void> {
	if (anchors.length === 0) return;
	const owned = await db
		.select({ id: sceneMarkers.id })
		.from(sceneMarkers)
		.where(
			and(
				eq(sceneMarkers.sceneId, sceneId),
				inArray(
					sceneMarkers.id,
					anchors.map((anchor) => anchor.id)
				)
			)
		);
	const known = new Set(owned.map((row) => row.id));
	for (const anchor of anchors) {
		if (!known.has(anchor.id)) continue;
		await db
			.update(sceneMarkers)
			.set({ anchorStart: anchor.anchorStart, anchorEnd: anchor.anchorEnd })
			.where(eq(sceneMarkers.id, anchor.id));
	}
}

// Unresolved markers across a story, for the continuous view's stitched
// editors, grouped by scene.
export async function listStoryMarkersByScene(db: Database, storyId: string) {
	const rows = await db
		.select({
			id: sceneMarkers.id,
			sceneId: sceneMarkers.sceneId,
			anchorStart: sceneMarkers.anchorStart,
			anchorEnd: sceneMarkers.anchorEnd
		})
		.from(sceneMarkers)
		.innerJoin(scenes, eq(sceneMarkers.sceneId, scenes.id))
		.where(and(eq(scenes.storyId, storyId), isNull(sceneMarkers.resolvedAt)))
		.orderBy(asc(sceneMarkers.anchorStart));
	const byScene: Record<
		string,
		{ id: string; anchorStart: number | null; anchorEnd: number | null }[]
	> = {};
	for (const row of rows) {
		(byScene[row.sceneId] ??= []).push({
			id: row.id,
			anchorStart: row.anchorStart,
			anchorEnd: row.anchorEnd
		});
	}
	return byScene;
}

// Unresolved markers for one scene, for the editor's highlights.
export async function listSceneMarkers(db: Database, sceneId: string) {
	return await db
		.select({
			id: sceneMarkers.id,
			anchorStart: sceneMarkers.anchorStart,
			anchorEnd: sceneMarkers.anchorEnd,
			bodyMd: sceneMarkers.bodyMd
		})
		.from(sceneMarkers)
		.where(and(eq(sceneMarkers.sceneId, sceneId), isNull(sceneMarkers.resolvedAt)))
		.orderBy(asc(sceneMarkers.anchorStart));
}

export type StoryTodo = {
	sceneId: string;
	sceneTitle: string | null;
	// Structured markers carry an id and can be checked off; text TODOs
	// carry null and resolve by deleting the line.
	markerId: string | null;
	text: string;
};

// Everything still to do across the story: unresolved selection markers
// plus TODO: lines found in the prose, in scene order.
export async function listStoryTodos(db: Database, storyId: string): Promise<StoryTodo[]> {
	const sceneRows = await db
		.select({ id: scenes.id, title: scenes.title, bodyMd: scenes.bodyMd })
		.from(scenes)
		.where(eq(scenes.storyId, storyId))
		.orderBy(asc(scenes.globalPosition));
	const markerRows = await db
		.select({
			id: sceneMarkers.id,
			sceneId: sceneMarkers.sceneId,
			anchorStart: sceneMarkers.anchorStart,
			anchorEnd: sceneMarkers.anchorEnd,
			bodyMd: sceneMarkers.bodyMd
		})
		.from(sceneMarkers)
		.innerJoin(scenes, eq(sceneMarkers.sceneId, scenes.id))
		.where(and(eq(scenes.storyId, storyId), isNull(sceneMarkers.resolvedAt)))
		.orderBy(asc(scenes.globalPosition), asc(sceneMarkers.anchorStart));

	const todos: StoryTodo[] = [];
	for (const scene of sceneRows) {
		for (const marker of markerRows.filter((row) => row.sceneId === scene.id)) {
			const snippet =
				marker.anchorStart !== null && marker.anchorEnd !== null
					? scene.bodyMd.slice(marker.anchorStart, marker.anchorEnd)
					: '';
			todos.push({
				sceneId: scene.id,
				sceneTitle: scene.title,
				markerId: marker.id,
				text: marker.bodyMd || snippet.slice(0, 120)
			});
		}
		for (const line of findTodoLines(scene.bodyMd)) {
			todos.push({
				sceneId: scene.id,
				sceneTitle: scene.title,
				markerId: null,
				text: line.text || 'TODO'
			});
		}
	}
	return todos;
}
