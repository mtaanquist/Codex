import { and, asc, eq, isNull, sql } from 'drizzle-orm';
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
// landed. One UPDATE over unnested arrays; the scene_id condition keeps
// the write to the scene's own markers.
export async function updateMarkerAnchors(
	db: Database,
	sceneId: string,
	anchors: { id: string; anchorStart: number; anchorEnd: number }[]
): Promise<void> {
	if (anchors.length === 0) return;
	// array[...] constructors, since a bare array parameter binds as a
	// record rather than a Postgres array.
	const column = (values: (string | number)[]) =>
		sql.join(
			values.map((value) => sql`${value}`),
			sql`, `
		);
	await db.execute(sql`
		update scene_markers set
			anchor_start = v.anchor_start,
			anchor_end = v.anchor_end
		from (
			select
				unnest(array[${column(anchors.map((anchor) => anchor.id))}]::uuid[]) as id,
				unnest(array[${column(anchors.map((anchor) => anchor.anchorStart))}]::int[]) as anchor_start,
				unnest(array[${column(anchors.map((anchor) => anchor.anchorEnd))}]::int[]) as anchor_end
		) as v
		where scene_markers.id = v.id and scene_markers.scene_id = ${sceneId}
	`);
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
