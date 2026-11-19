import { and, eq, isNull, sql } from 'drizzle-orm';
import type { ActionFailure } from './action-result';
import type { Database } from './auth';
import { chapters, scenes } from './db/schema';
import { markChapterSummariesStale, markMentionsStale } from './scene-lifecycle.ts';

export type SceneOrder = {
	chapters: { id: string; sceneIds: string[] }[];
	orphanSceneIds: string[];
};

// The order names every chapter and scene, so a mismatch almost always means
// the page is out of date (a scene added or trashed elsewhere).
const STALE_ORDER = 'The story changed since this page loaded. Reload and try again.';

// The scenes whose place relative to the others changed between two orders:
// everything outside a longest run that kept its relative order. Moving one
// scene from the start to the end names only that scene, though every other
// scene's rank shifts. Scenes missing from `was` count as moved.
export function movedScenes(was: string[], now: string[]): string[] {
	const rank = new Map(was.map((id, i) => [id, i]));
	const ranks = now.map((id) => rank.get(id) ?? -1);
	// Longest strictly increasing run of old ranks (patience sorting), kept as
	// indexes into `now` so the run can be walked back.
	const tails: number[] = [];
	const prev: number[] = new Array(now.length).fill(-1);
	ranks.forEach((r, i) => {
		if (r < 0) return;
		let lo = 0;
		let hi = tails.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (ranks[tails[mid]] < r) lo = mid + 1;
			else hi = mid;
		}
		if (lo > 0) prev[i] = tails[lo - 1];
		tails[lo] = i;
	});
	const kept = new Set<number>();
	for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) kept.add(i);
	return now.filter((_, i) => !kept.has(i));
}

// Applies a full ordering of a story's scenes: every chapter and every scene
// must appear exactly once. Renumbering the whole story keeps the positions
// consistent no matter what moved; stories are small enough that this costs
// nothing.
export async function applySceneOrder(
	db: Database,
	storyId: string,
	order: SceneOrder
): Promise<{ ok: true } | ActionFailure> {
	const chapterRows = await db
		.select({ id: chapters.id })
		.from(chapters)
		.where(eq(chapters.storyId, storyId));
	// Trashed scenes sit outside the order until restored.
	const sceneRows = await db
		.select({ id: scenes.id, chapterId: scenes.chapterId, globalPosition: scenes.globalPosition })
		.from(scenes)
		.where(and(eq(scenes.storyId, storyId), isNull(scenes.deletedAt)));

	const chapterIds = new Set(chapterRows.map((row) => row.id));
	const orderedChapterIds = new Set(order.chapters.map((chapter) => chapter.id));
	if (
		orderedChapterIds.size !== order.chapters.length ||
		chapterIds.size !== orderedChapterIds.size ||
		[...orderedChapterIds].some((id) => !chapterIds.has(id))
	) {
		return { ok: false, code: 'conflict', reason: STALE_ORDER };
	}

	const sceneIds = new Set(sceneRows.map((row) => row.id));
	const orderedSceneIds = [
		...order.chapters.flatMap((chapter) => chapter.sceneIds),
		...order.orphanSceneIds
	];
	if (
		new Set(orderedSceneIds).size !== orderedSceneIds.length ||
		sceneIds.size !== orderedSceneIds.length ||
		orderedSceneIds.some((id) => !sceneIds.has(id))
	) {
		return { ok: false, code: 'conflict', reason: STALE_ORDER };
	}

	// One UPDATE over unnested arrays instead of a statement per scene.
	const ids: string[] = [];
	const targetChapters: (string | null)[] = [];
	const chapterPositions: (number | null)[] = [];
	const globalPositions: number[] = [];
	let globalPosition = 0;
	for (const chapter of order.chapters) {
		chapter.sceneIds.forEach((sceneId, index) => {
			globalPosition += 1;
			ids.push(sceneId);
			targetChapters.push(chapter.id);
			chapterPositions.push(index + 1);
			globalPositions.push(globalPosition);
		});
	}
	for (const sceneId of order.orphanSceneIds) {
		globalPosition += 1;
		ids.push(sceneId);
		targetChapters.push(null);
		chapterPositions.push(null);
		globalPositions.push(globalPosition);
	}
	if (ids.length > 0) {
		// array[...] constructors, since a bare array parameter binds as a
		// record rather than a Postgres array.
		const column = (values: (string | number | null)[]) =>
			sql.join(
				values.map((value) => sql`${value}`),
				sql`, `
			);
		// Compared by reading order among live scenes, not the stored number:
		// renumbering closes the gap a trashed scene left without changing it.
		const was = [...sceneRows]
			.sort((a, b) => a.globalPosition - b.globalPosition)
			.map((row) => row.id);
		const moved = movedScenes(was, ids);
		// A scene dropped into another chapter was moved too, even when its
		// reading order stays the same. Both chapters now hold different scenes.
		const chapterWas = new Map(sceneRows.map((row) => [row.id, row.chapterId]));
		const rechaptered: string[] = [];
		const chaptersChanged = new Set<string>();
		ids.forEach((id, i) => {
			const from = chapterWas.get(id) ?? null;
			if (from === targetChapters[i]) return;
			rechaptered.push(id);
			for (const chapter of [from, targetChapters[i]]) if (chapter) chaptersChanged.add(chapter);
		});
		// Only what the writer moved counts as a change; the scenes it shifted
		// keep their touched_at.
		const touched = [...new Set([...moved, ...rechaptered])];
		await db.transaction(async (tx) => {
			await tx.execute(sql`
			update scenes set
				chapter_id = v.chapter_id,
				position_in_chapter = v.position_in_chapter,
				global_position = v.global_position,
				touched_at = case
					when scenes.id = any(array[${column(touched)}]::uuid[])
					then clock_timestamp() else scenes.touched_at end
			from (
				select
					unnest(array[${column(ids)}]::uuid[]) as id,
					unnest(array[${column(targetChapters)}]::uuid[]) as chapter_id,
					unnest(array[${column(chapterPositions)}]::int[]) as position_in_chapter,
					unnest(array[${column(globalPositions)}]::int[]) as global_position
			) as v
			where scenes.id = v.id
		`);
			// Arcs retell the character's scenes in reading order. Only what a
			// moved scene mentions can read in a new order.
			await markMentionsStale(tx, { sceneIds: moved });
			await markChapterSummariesStale(tx, [...chaptersChanged]);
		});
	}
	return { ok: true };
}
