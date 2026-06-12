import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from './auth.ts';
import { scenes } from './db/schema.ts';
import { listThreads } from './review.ts';
import { reanchorRange } from '../review-anchor.ts';
import type { ExportReviewThread, ReviewLoader } from './export.ts';

// Long selections are trimmed: the excerpt locates the thread, the scene
// file holds the text.
const EXCERPT_MAX = 240;

// Gathers a story's review threads for the account export: each thread with
// its comments, attribution, and the text its anchor points at in the
// current scene body. Lives outside export.ts so the worker's import of the
// export builders does not drag in the review module.
export function reviewLoader(db: Database): ReviewLoader {
	return async (storyId) => {
		const threads = await listThreads(db, storyId, reanchorRange);
		if (threads.length === 0) return [];
		const sceneRows = await db
			.select({ id: scenes.id, title: scenes.title, bodyMd: scenes.bodyMd })
			.from(scenes)
			.where(and(eq(scenes.storyId, storyId), isNull(scenes.deletedAt)));
		const liveScenes = new Map(sceneRows.map((scene) => [scene.id, scene]));
		const exported: ExportReviewThread[] = [];
		for (const thread of threads) {
			// A trashed scene's prose is out of the export; so are its threads.
			const scene = liveScenes.get(thread.sceneId);
			if (!scene) continue;
			let excerpt: string | null = null;
			if (thread.anchor) {
				excerpt = scene.bodyMd.slice(thread.anchor.start, thread.anchor.end);
				if (excerpt.length > EXCERPT_MAX) excerpt = `${excerpt.slice(0, EXCERPT_MAX)}...`;
			}
			exported.push({
				sceneTitle: scene.title,
				resolved: thread.resolvedAt !== null,
				excerpt,
				anchorLost: thread.anchorLost,
				comments: thread.comments.map((comment) => ({
					authorName: comment.authorName,
					isOwner: comment.isOwner,
					createdAt: comment.createdAt,
					body: comment.body
				}))
			});
		}
		return exported;
	};
}
