import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { Database } from './auth';
import { scenes, stories } from './db/schema';
import { inLiveUniverse } from './universe-scope';

// The owned-scene lookup shared by everything that reads or mutates a scene:
// ownership flows through the story, and soft-deleted scenes are filtered by
// default so the trash check cannot be forgotten, as is a scene in a trashed
// universe. Pass deleted: true for the
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
				inLiveUniverse(stories.universeId),
				options.deleted ? isNotNull(scenes.deletedAt) : isNull(scenes.deletedAt)
			)
		);
	return row ?? null;
}
