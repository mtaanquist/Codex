import { eq } from 'drizzle-orm';
import type { Database } from './auth';
import { scenes } from './db/schema';
import { ownedScene } from './scene-access.ts';
import type { SceneStatus } from '../scene-status';

/** Owner-guarded status change. False when the scene is not the user's. */
export async function setSceneStatus(
	db: Database,
	userId: string,
	sceneId: string,
	status: SceneStatus
): Promise<boolean> {
	const row = await ownedScene(db, userId, sceneId);
	if (!row) return false;
	await db.update(scenes).set({ status }).where(eq(scenes.id, row.id));
	return true;
}
