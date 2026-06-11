import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { Database } from './auth';
import { scenes, stories } from './db/schema';

// The owned-scene lookup shared by everything that reads or mutates a scene:
// ownership flows through the story, and soft-deleted scenes are filtered by
// default so the trash check cannot be forgotten. Pass deleted: true for the
// trash operations that work on a trashed scene. story-access.ts is the
// sibling for stories.
export async function ownedScene(
	db: Database,
	userId: string,
	sceneId: string,
	options: { deleted?: boolean } = {}
) {
	const [row] = await db
		.select({
			id: scenes.id,
			storyId: scenes.storyId,
			chapterId: scenes.chapterId,
			positionInChapter: scenes.positionInChapter,
			globalPosition: scenes.globalPosition,
			bodyMd: scenes.bodyMd,
			status: scenes.status
		})
		.from(scenes)
		.innerJoin(stories, eq(scenes.storyId, stories.id))
		.where(
			and(
				eq(scenes.id, sceneId),
				eq(stories.ownerId, userId),
				options.deleted ? isNotNull(scenes.deletedAt) : isNull(scenes.deletedAt)
			)
		);
	return row ?? null;
}
