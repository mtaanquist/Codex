import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Database } from './auth.ts';
import { scenes, stories } from './db/schema.ts';
import { storyIsLive } from './universe-scope.ts';

// Spread into the set of an update that leaves the prose alone (a move, a
// status, the trash). Without it updated_at's $onUpdate bumps the row, and the
// scene's Assistant summary then reads as out of date and is paid for again.
// touched_at still moves, so the change counts as editing the story.
export function keepUpdatedAt() {
	return { updatedAt: sql`${scenes.updatedAt}` };
}

// The owned-scene lookup shared by everything that reads or mutates a scene:
// ownership flows through the story, and soft-deleted scenes and scenes in a
// trashed universe are filtered by default so the trash check cannot be
// forgotten. Pass deleted: true for the trash operations that work on a
// trashed scene. story-access.ts is the sibling for stories.
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
				storyIsLive(),
				options.deleted ? isNotNull(scenes.deletedAt) : isNull(scenes.deletedAt)
			)
		);
	return row ?? null;
}

// The live scene changed last, prose or not: the one a story opens on when no
// scene is named. The caller has already checked the story is the user's.
export async function lastTouchedScene(db: Database, storyId: string) {
	const [row] = await db
		.select()
		.from(scenes)
		.where(and(eq(scenes.storyId, storyId), isNull(scenes.deletedAt)))
		.orderBy(desc(scenes.touchedAt))
		.limit(1);
	return row ?? null;
}
