import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from './auth';
import { scenes, stories } from './db/schema';
import type { SceneStatus } from '../scene-status';

/** Owner-guarded status change. False when the scene is not the user's. */
export async function setSceneStatus(
	db: Database,
	userId: string,
	sceneId: string,
	status: SceneStatus
): Promise<boolean> {
	const [row] = await db
		.select({ id: scenes.id })
		.from(scenes)
		.innerJoin(stories, eq(scenes.storyId, stories.id))
		.where(and(eq(scenes.id, sceneId), eq(stories.ownerId, userId), isNull(scenes.deletedAt)));
	if (!row) return false;
	await db.update(scenes).set({ status }).where(eq(scenes.id, row.id));
	return true;
}
