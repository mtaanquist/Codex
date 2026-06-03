import { eq } from 'drizzle-orm';
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

	await db.transaction(async (tx) => {
		let globalPosition = 0;
		for (const chapter of order.chapters) {
			let positionInChapter = 0;
			for (const sceneId of chapter.sceneIds) {
				globalPosition += 1;
				positionInChapter += 1;
				await tx
					.update(scenes)
					.set({ chapterId: chapter.id, positionInChapter, globalPosition })
					.where(eq(scenes.id, sceneId));
			}
		}
		for (const sceneId of order.orphanSceneIds) {
			globalPosition += 1;
			await tx
				.update(scenes)
				.set({ chapterId: null, positionInChapter: null, globalPosition })
				.where(eq(scenes.id, sceneId));
		}
	});
	return { ok: true };
}
