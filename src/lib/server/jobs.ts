import { PgBoss } from 'pg-boss';
import { env } from '$env/dynamic/private';
import type { EmailMessage } from './email';

// Send-only pg-boss handle for the app; the worker process owns the handlers.
// Queueing is best-effort: a failed enqueue logs and never breaks a save. A
// dropped mention rebuild is not lost for good - the worker's reconcile sweep
// (see mentions.ts reconcileMentions) re-indexes any scene whose watermark has
// fallen behind, so the index self-heals within minutes.

export const MENTIONS_SCENE_QUEUE = 'mentions-scene';
export const MENTIONS_UNIVERSE_QUEUE = 'mentions-universe';
export const BACKUP_QUEUE = 'run-backup';
export const EMAIL_QUEUE = 'send-email';
export const EXPORT_ARTIFACTS_QUEUE = 'export-artifacts';

let starting: Promise<PgBoss> | null = null;

function getBoss(): Promise<PgBoss> {
	starting ??= (async () => {
		const boss = new PgBoss(env.DATABASE_URL ?? 'postgres://codex:codex@localhost:5432/codex');
		boss.on('error', (error) => console.error('pg-boss error:', error));
		await boss.start();
		await boss.createQueue(MENTIONS_SCENE_QUEUE);
		await boss.createQueue(MENTIONS_UNIVERSE_QUEUE);
		await boss.createQueue(BACKUP_QUEUE);
		await boss.createQueue(EMAIL_QUEUE);
		await boss.createQueue(EXPORT_ARTIFACTS_QUEUE);
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

// Queues a transactional email (verification, password reset). Best-effort,
// like the mention queues: a failed enqueue logs rather than breaking the
// request, and the caller shows the same neutral "check your email" either way.
export async function queueEmail(message: EmailMessage): Promise<void> {
	try {
		const boss = await getBoss();
		await boss.send(EMAIL_QUEUE, message);
	} catch (error) {
		console.error('queueing email failed:', error);
	}
}

// Queues artifact generation for a published edition (markdown zip, EPUB,
// PDF stored in the asset bucket). Returns whether the enqueue succeeded so
// the page can offer "generate again" when it did not; a publish whose
// artifacts never appear is recovered the same way.
export async function queueExportArtifacts(publicationId: string): Promise<boolean> {
	try {
		const boss = await getBoss();
		const id = await boss.send(
			EXPORT_ARTIFACTS_QUEUE,
			{ publicationId },
			{ singletonKey: publicationId, singletonSeconds: 10 }
		);
		return id !== null;
	} catch (error) {
		console.error('queueing export artifacts failed:', error);
		return false;
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
