import { PgBoss } from 'pg-boss';
import { env } from '$env/dynamic/private';
import type { EmailMessage } from './email';

// Send-only pg-boss handle for the app; the worker process owns the handlers.
// Queueing is best-effort: a failed enqueue logs and never breaks a save. A
// dropped mention rebuild is not lost for good - the worker's reconcile sweep
// (see mentions.ts reconcileMentions) re-indexes any scene whose watermark has
// fallen behind, so the index self-heals within minutes.

export {
	MENTIONS_SCENE_QUEUE,
	MENTIONS_UNIVERSE_QUEUE,
	BACKUP_QUEUE,
	EMAIL_QUEUE,
	EMAIL_DEAD_LETTER_QUEUE,
	EXPORT_ARTIFACTS_QUEUE,
	USER_EXPORT_QUEUE,
	MIGRATE_ASSETS_QUEUE,
	NOTIFICATION_DIGEST_QUEUE,
	REVIEWER_DIGEST_QUEUE,
	ASSISTANT_REVIEW_QUEUE,
	ASSISTANT_SUMMARIES_QUEUE
} from './queues.ts';
import {
	DIGEST_DELAY_SECONDS,
	MENTIONS_SCENE_QUEUE,
	MENTIONS_UNIVERSE_QUEUE,
	BACKUP_QUEUE,
	EMAIL_QUEUE,
	EMAIL_DEAD_LETTER_QUEUE,
	EXPORT_ARTIFACTS_QUEUE,
	USER_EXPORT_QUEUE,
	MIGRATE_ASSETS_QUEUE,
	NOTIFICATION_DIGEST_QUEUE,
	REVIEWER_DIGEST_QUEUE,
	ASSISTANT_REVIEW_QUEUE,
	ASSISTANT_SUMMARIES_QUEUE
} from './queues.ts';

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
		await boss.createQueue(EMAIL_DEAD_LETTER_QUEUE);
		await boss.createQueue(EXPORT_ARTIFACTS_QUEUE);
		await boss.createQueue(USER_EXPORT_QUEUE);
		await boss.createQueue(MIGRATE_ASSETS_QUEUE);
		await boss.createQueue(NOTIFICATION_DIGEST_QUEUE);
		await boss.createQueue(REVIEWER_DIGEST_QUEUE);
		await boss.createQueue(ASSISTANT_REVIEW_QUEUE);
		await boss.createQueue(ASSISTANT_SUMMARIES_QUEUE);
		return boss;
	})();
	return starting;
}

// Schedules a user's notification digest. The singleton key keeps one
// pending job per user: the first notification starts the clock, and
// everything arriving inside the window rides the same email.
export async function queueNotificationDigest(userId: string): Promise<void> {
	try {
		const boss = await getBoss();
		await boss.send(
			NOTIFICATION_DIGEST_QUEUE,
			{ userId },
			{ startAfter: DIGEST_DELAY_SECONDS, singletonKey: userId }
		);
	} catch (error) {
		console.error('queueing notification digest failed:', error);
	}
}

// The same, for a guest reviewer (email, no account).
export async function queueReviewerDigest(reviewerId: string): Promise<void> {
	try {
		const boss = await getBoss();
		await boss.send(
			REVIEWER_DIGEST_QUEUE,
			{ reviewerId },
			{ startAfter: DIGEST_DELAY_SECONDS, singletonKey: reviewerId }
		);
	} catch (error) {
		console.error('queueing reviewer digest failed:', error);
	}
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

// Send-email retry policy: an SMTP outage of a few seconds to a couple of
// hours is ridden out rather than dropping account-critical mail. Exponential
// backoff from a minute, each delay capped at an hour, over ten tries (~5h
// total). A job that still fails is routed to the dead-letter queue, where the
// worker logs it so an operator can see what was dropped.
const EMAIL_RETRY = {
	retryLimit: 10,
	retryDelay: 60,
	retryBackoff: true,
	retryDelayMax: 3600
} as const;

// Queues a transactional email (verification, password reset). Best-effort
// enqueue, like the mention queues: a failed enqueue logs rather than breaking
// the request, and the caller shows the same neutral "check your email" either
// way. Once queued, the retry policy above keeps the send alive through an
// outage.
export async function queueEmail(message: EmailMessage): Promise<void> {
	try {
		const boss = await getBoss();
		await boss.send(EMAIL_QUEUE, message, {
			...EMAIL_RETRY,
			deadLetter: EMAIL_DEAD_LETTER_QUEUE
		});
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
		// A wide dedup window plus singletonNextSlot: a regeneration requested
		// while one is in flight is deferred to run once after it, rather than
		// interleaving S3 puts and row upserts for the same edition. Artifact
		// builds (PDF via headless Chromium) can take a while, so the window is
		// minutes, not seconds.
		const id = await boss.send(
			EXPORT_ARTIFACTS_QUEUE,
			{ publicationId },
			{ singletonKey: publicationId, singletonSeconds: 300, singletonNextSlot: true }
		);
		return id !== null;
	} catch (error) {
		console.error('queueing export artifacts failed:', error);
		return false;
	}
}

// Queues a user-requested export (account, story, or universe archive, or a
// story EPUB). The heavy build runs in the worker so it never blocks the web
// process; the page shows the finished file once it lands. Returns whether the
// enqueue succeeded so the caller can mark the row failed if it did not.
export async function queueUserExport(exportId: string): Promise<boolean> {
	try {
		const boss = await getBoss();
		const id = await boss.send(USER_EXPORT_QUEUE, { exportId }, { singletonKey: exportId });
		return id !== null;
	} catch (error) {
		console.error('queueing user export failed:', error);
		return false;
	}
}

// Queues a whole-story or single-chapter Assistant review. The singleton key
// (story + chapter scope) coalesces repeat requests so a writer cannot pile up
// duplicate passes over the same scenes while one is already running.
export async function queueAssistantReview(input: {
	userId: string;
	storyId: string;
	chapterId?: string;
}): Promise<boolean> {
	try {
		const boss = await getBoss();
		const scope = input.chapterId ? `${input.storyId}:${input.chapterId}` : input.storyId;
		const id = await boss.send(ASSISTANT_REVIEW_QUEUE, input, {
			singletonKey: scope,
			singletonSeconds: 30
		});
		return id !== null;
	} catch (error) {
		console.error('queueing assistant review failed:', error);
		return false;
	}
}

// Queues a whole-story summary-maintenance pass. The singleton key (the story)
// coalesces repeat requests so a writer cannot pile up duplicate passes over the
// same scenes while one is already running.
export async function queueAssistantSummaries(input: {
	userId: string;
	storyId: string;
}): Promise<boolean> {
	try {
		const boss = await getBoss();
		const id = await boss.send(ASSISTANT_SUMMARIES_QUEUE, input, {
			singletonKey: input.storyId,
			singletonSeconds: 30
		});
		return id !== null;
	} catch (error) {
		console.error('queueing assistant summaries failed:', error);
		return false;
	}
}

// Copies stored assets to newly saved storage, queued from the admin page.
// The singleton key keeps one migration in flight at a time.
export async function queueAssetMigration(): Promise<boolean> {
	try {
		const boss = await getBoss();
		const id = await boss.send(
			MIGRATE_ASSETS_QUEUE,
			{},
			{ singletonKey: 'migrate-assets', singletonSeconds: 30 }
		);
		return id !== null;
	} catch (error) {
		console.error('queueing asset migration failed:', error);
		return false;
	}
}

// Keeps the worker's backup schedule in step when the settings change in the
// admin panel, without waiting for a worker restart. The worker reconciles
// the same schedule at startup.
export async function applyBackupSchedule(cron: string | null): Promise<void> {
	try {
		const boss = await getBoss();
		if (cron) await boss.schedule(BACKUP_QUEUE, cron, { trigger: 'scheduled' }, { tz: 'UTC' });
		else await boss.unschedule(BACKUP_QUEUE);
	} catch (error) {
		console.error('applying the backup schedule failed:', error);
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
