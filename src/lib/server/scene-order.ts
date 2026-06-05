import { eq, sql } from 'drizzle-orm';
import type { Database } from './auth';
import { chapters, scenes } from './db/schema';

export type SceneOrder = {
	chapters: { id: string; sceneIds: string[] }[];
	orphanSceneIds: string[];
};

// Applies a full ordering of a story's scenes: every chapter and every scene
// must appear exactly once. Renumbering the whole story keeps the positions
// consistent no matter what moved; stories are small enough that this costs
// nothing.
export async function applySceneOrder(
	db: Database,
	storyId: string,
	order: SceneOrder
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const chapterRows = await db
		.select({ id: chapters.id })
		.from(chapters)
		.where(eq(chapters.storyId, storyId));
	const sceneRows = await db
		.select({ id: scenes.id })
		.from(scenes)
		.where(eq(scenes.storyId, storyId));

	const chapterIds = new Set(chapterRows.map((row) => row.id));
	const orderedChapterIds = new Set(order.chapters.map((chapter) => chapter.id));
	if (
		orderedChapterIds.size !== order.chapters.length ||
		chapterIds.size !== orderedChapterIds.size ||
		[...orderedChapterIds].some((id) => !chapterIds.has(id))
	) {
		return { ok: false, reason: 'order must list each chapter of the story exactly once' };
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
		return { ok: false, reason: 'order must list each scene of the story exactly once' };
	}

	// One UPDATE over unnested arrays instead of a statement per scene; a
	// single statement is also atomic, so no transaction is needed.
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
		await db.execute(sql`
			update scenes set
				chapter_id = v.chapter_id,
				position_in_chapter = v.position_in_chapter,
				global_position = v.global_position
			from (
				select
					unnest(array[${column(ids)}]::uuid[]) as id,
					unnest(array[${column(targetChapters)}]::uuid[]) as chapter_id,
					unnest(array[${column(chapterPositions)}]::int[]) as position_in_chapter,
					unnest(array[${column(globalPositions)}]::int[]) as global_position
			) as v
			where scenes.id = v.id
		`);
	}
	return { ok: true };
}
