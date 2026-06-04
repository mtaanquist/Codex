import { PgBoss } from 'pg-boss';
import { env } from '$env/dynamic/private';

// Send-only pg-boss handle for the app; the worker process owns the handlers.
// Queueing is best-effort: a failed enqueue logs and never breaks a save.

export const MENTIONS_SCENE_QUEUE = 'mentions-scene';
export const MENTIONS_UNIVERSE_QUEUE = 'mentions-universe';
export const BACKUP_QUEUE = 'run-backup';

let starting: Promise<PgBoss> | null = null;

function getBoss(): Promise<PgBoss> {
	starting ??= (async () => {
		const boss = new PgBoss(env.DATABASE_URL ?? 'postgres://codex:codex@localhost:5432/codex');
		boss.on('error', (error) => console.error('pg-boss error:', error));
		await boss.start();
		await boss.createQueue(MENTIONS_SCENE_QUEUE);
		await boss.createQueue(MENTIONS_UNIVERSE_QUEUE);
		await boss.createQueue(BACKUP_QUEUE);
		return boss;
	})();
	return starting;
}

export async function queueSceneMentions(sceneId: string): Promise<void> {
	try {
		const boss = await getBoss();
		// The singleton key coalesces the burst of autosaves while typing;
		// singletonNextSlot defers (rather than drops) a send that lands inside
		// an occupied slot, so the trailing save always gets a rebuild.
		await boss.send(
			MENTIONS_SCENE_QUEUE,
			{ sceneId },
			{ singletonKey: sceneId, singletonSeconds: 2, singletonNextSlot: true }
		);
	} catch (error) {
		console.error('queueing scene mention rebuild failed:', error);
	}
}

export async function queueUniverseMentions(universeId: string): Promise<void> {
	try {
		const boss = await getBoss();
		await boss.send(
			MENTIONS_UNIVERSE_QUEUE,
			{ universeId },
			{ singletonKey: universeId, singletonSeconds: 5, singletonNextSlot: true }
		);
	} catch (error) {
		console.error('queueing universe mention rebuild failed:', error);
	}
}

// Ad-hoc backup, queued from the admin page. Unlike the mention queues
// this returns whether the enqueue succeeded, so the page can say so; the
// singleton key stops a double-click from running two dumps at once.
export async function queueBackup(): Promise<boolean> {
	try {
		const boss = await getBoss();
		const id = await boss.send(
			BACKUP_QUEUE,
			{ trigger: 'manual' },
			{ singletonKey: 'backup', singletonSeconds: 30 }
		);
		return id !== null;
	} catch (error) {
		console.error('queueing backup failed:', error);
		return false;
	}
}
