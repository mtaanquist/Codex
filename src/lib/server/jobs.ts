import { PgBoss } from 'pg-boss';
import { DATABASE_URL } from '$app/env/private';
import type { EmailJob } from './token-email';
import type { PatternScope, ReviewCategory } from '../review-shape';
import { db } from './db';
import { markUniverseMentionsChanged } from './mentions.ts';

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
	ASSISTANT_SUMMARIES_QUEUE,
	ASSISTANT_ENRICH_QUEUE,
	ASSISTANT_DRAFT_QUEUE
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
	ASSISTANT_SUMMARIES_QUEUE,
	ASSISTANT_ENRICH_QUEUE,
	ASSISTANT_DRAFT_QUEUE,
	ASSISTANT_QUEUE_OPTIONS,
	LEGACY_ASSISTANT_REVIEW_QUEUE,
	LEGACY_ASSISTANT_SUMMARIES_QUEUE,
	ASSISTANT_JOB_EXPIRY_SECONDS,
	JOB_HEARTBEAT_SECONDS
} from './queues.ts';
import { reviewScopeKey } from './review-runs.ts';
import {
	findRunningAssistantJobs,
	stopAssistantJob,
	type RunningAssistantJob
} from './running-jobs.ts';
import { errorFields, logEvent, redactEmail } from './log.ts';
import type { ReviewRunState } from './db/schema.ts';

let starting: Promise<PgBoss> | null = null;

function getBoss(): Promise<PgBoss> {
	starting ??= (async () => {
		const boss = new PgBoss(DATABASE_URL ?? 'postgres://codex:codex@localhost:5432/codex');
		boss.on('error', (error) => logEvent('error', 'pgboss.error', errorFields(error)));
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
		await boss.createQueue(ASSISTANT_REVIEW_QUEUE, ASSISTANT_QUEUE_OPTIONS);
		await boss.createQueue(ASSISTANT_SUMMARIES_QUEUE, ASSISTANT_QUEUE_OPTIONS);
		await boss.createQueue(ASSISTANT_ENRICH_QUEUE, ASSISTANT_QUEUE_OPTIONS);
		await boss.createQueue(ASSISTANT_DRAFT_QUEUE, ASSISTANT_QUEUE_OPTIONS);
		// LEGACY (#1041): so getAssistantJobState can look in them on any install.
		await boss.createQueue(LEGACY_ASSISTANT_REVIEW_QUEUE);
		await boss.createQueue(LEGACY_ASSISTANT_SUMMARIES_QUEUE);
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
		logEvent('error', 'job.queue_failed', {
			queue: NOTIFICATION_DIGEST_QUEUE,
			userId,
			...errorFields(error)
		});
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
		logEvent('error', 'job.queue_failed', {
			queue: REVIEWER_DIGEST_QUEUE,
			reviewerId,
			...errorFields(error)
		});
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
		logEvent('error', 'job.queue_failed', {
			queue: MENTIONS_SCENE_QUEUE,
			sceneId,
			...errorFields(error)
		});
	}
}

// Call after any change to what the universe's scenes can mention. The flag
// is what lets the reconcile sweep catch a dropped job, so it is set first.
export async function queueUniverseMentions(universeId: string): Promise<void> {
	try {
		await markUniverseMentionsChanged(db, universeId);
	} catch (error) {
		logEvent('error', 'mentions.flag_failed', { universeId, ...errorFields(error) });
	}
	try {
		const boss = await getBoss();
		await boss.send(
			MENTIONS_UNIVERSE_QUEUE,
			{ universeId },
			{ singletonKey: universeId, singletonSeconds: 5, singletonNextSlot: true }
		);
	} catch (error) {
		logEvent('error', 'job.queue_failed', {
			queue: MENTIONS_UNIVERSE_QUEUE,
			universeId,
			...errorFields(error)
		});
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

// Queues a transactional email (verification, password reset). A link email
// is queued by token id, never with the raw token; the worker builds it (see
// token-email.ts). Best-effort enqueue, like the mention queues: a failed
// enqueue logs rather than breaking the request, and the caller shows the same
// neutral "check your email" either way. Once queued, the retry policy above
// keeps the send alive through an outage.
export async function queueEmail(message: EmailJob): Promise<void> {
	try {
		const boss = await getBoss();
		await boss.send(EMAIL_QUEUE, message, {
			...EMAIL_RETRY,
			deadLetter: EMAIL_DEAD_LETTER_QUEUE
		});
	} catch (error) {
		logEvent('error', 'job.queue_failed', {
			queue: EMAIL_QUEUE,
			to: redactEmail(message.to),
			...errorFields(error)
		});
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
			{
				singletonKey: publicationId,
				singletonSeconds: 300,
				singletonNextSlot: true,
				heartbeatSeconds: JOB_HEARTBEAT_SECONDS
			}
		);
		return id !== null;
	} catch (error) {
		logEvent('error', 'job.queue_failed', {
			queue: EXPORT_ARTIFACTS_QUEUE,
			publicationId,
			...errorFields(error)
		});
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
		const id = await boss.send(
			USER_EXPORT_QUEUE,
			{ exportId },
			{ singletonKey: exportId, heartbeatSeconds: JOB_HEARTBEAT_SECONDS }
		);
		return id !== null;
	} catch (error) {
		logEvent('error', 'job.queue_failed', {
			queue: USER_EXPORT_QUEUE,
			exportId,
			...errorFields(error)
		});
		return false;
	}
}

// An Assistant run talks to a model for as long as the story is big, so the
// 15-minute default expiry would hand the job out again mid-run. The generous
// expiry is the outer limit on one run; the heartbeat is what notices a worker
// that died, so its job is retried within a minute or two instead of hours. The
// group is the writer: the worker runs one job per writer at a time, so one
// slow endpoint holds up only its own writer's queue.
function assistantSendOptions(userId: string) {
	return {
		expireInSeconds: ASSISTANT_JOB_EXPIRY_SECONDS,
		heartbeatSeconds: JOB_HEARTBEAT_SECONDS,
		retryLimit: 2,
		group: { id: userId }
	};
}

// Queues a background Assistant review. Three shapes share the queue: a
// whole-story or single-chapter copyedit (storyId, the default 'full' mode), a
// standalone story continuity pass (storyId, mode 'continuity'), and a
// universe-wide continuity pass (universeId, mode 'continuity'). The singleton
// key holds one unfinished job per scope, so a second request while a pass is
// queued or running is dropped rather than starting a duplicate run over the
// same scenes. Returns the job id so the caller can poll it to completion, or
// null if the enqueue failed (or coalesced into a job already in flight).
export async function queueAssistantReview(input: {
	userId: string;
	storyId?: string;
	universeId?: string;
	chapterId?: string;
	// The categories to check: empty is the sparing pass, all three the full
	// copyedit plus the cross-scene consistency pass. Ignored by the continuity
	// mode, which runs the consistency pass alone.
	categories: ReviewCategory[];
	mode?: 'full' | 'continuity';
	// The pattern pass to add before the scene reviews, if any.
	patterns?: PatternScope;
}): Promise<string | 'coalesced' | null> {
	try {
		const boss = await getBoss();
		const jobId = await boss.send(ASSISTANT_REVIEW_QUEUE, input, {
			singletonKey: reviewScopeKey(input),
			...assistantSendOptions(input.userId)
		});
		// pg-boss returns null when the singleton key coalesced this request into
		// a review that is already queued or running; the endpoint tells the
		// writer that, rather than reporting a failure.
		return jobId ?? 'coalesced';
	} catch (error) {
		logEvent('error', 'job.queue_failed', {
			queue: ASSISTANT_REVIEW_QUEUE,
			userId: input.userId,
			...errorFields(error)
		});
		return null;
	}
}

// Queues a whole-story summary-maintenance pass. The singleton key (the story)
// coalesces a repeat request into the pass already queued or running, so a
// writer cannot pile up duplicate passes over the same scenes.
export async function queueAssistantSummaries(input: {
	userId: string;
	storyId: string;
}): Promise<string | 'coalesced' | null> {
	try {
		const boss = await getBoss();
		const jobId = await boss.send(ASSISTANT_SUMMARIES_QUEUE, input, {
			singletonKey: input.storyId,
			...assistantSendOptions(input.userId)
		});
		return jobId ?? 'coalesced';
	} catch (error) {
		logEvent('error', 'job.queue_failed', {
			queue: ASSISTANT_SUMMARIES_QUEUE,
			storyId: input.storyId,
			...errorFields(error)
		});
		return null;
	}
}

// Queues the background enrichment pass over a universe's entities. The
// singleton key (the universe) coalesces a repeat request into the pass already
// queued or running.
export async function queueAssistantEnrich(input: {
	userId: string;
	universeId: string;
}): Promise<string | 'coalesced' | null> {
	try {
		const boss = await getBoss();
		const jobId = await boss.send(ASSISTANT_ENRICH_QUEUE, input, {
			singletonKey: input.universeId,
			...assistantSendOptions(input.userId)
		});
		return jobId ?? 'coalesced';
	} catch (error) {
		logEvent('error', 'job.queue_failed', {
			queue: ASSISTANT_ENRICH_QUEUE,
			universeId: input.universeId,
			...errorFields(error)
		});
		return null;
	}
}

// Queues a rewrite of one character's arc across the universe's stories. It
// shares the enrichment queue (and so the one-job-per-writer limit); the
// singleton key holds one unfinished rewrite per character.
export async function queueAssistantArc(input: {
	userId: string;
	universeId: string;
	characterId: string;
}): Promise<string | 'coalesced' | null> {
	try {
		const boss = await getBoss();
		const jobId = await boss.send(ASSISTANT_ENRICH_QUEUE, input, {
			singletonKey: `arc:${input.characterId}`,
			...assistantSendOptions(input.userId)
		});
		return jobId ?? 'coalesced';
	} catch (error) {
		logEvent('error', 'job.queue_failed', {
			queue: ASSISTANT_ENRICH_QUEUE,
			characterId: input.characterId,
			...errorFields(error)
		});
		return null;
	}
}

// Queues a full-text read of one entity (the "Suggest details" button). It
// shares the enrichment queue; the singleton key holds one unfinished read per
// entity. name is the entity's name when queued, for the activity card.
export async function queueAssistantDetails(input: {
	userId: string;
	universeId: string;
	read: { entityId: string; name: string; storyId?: string; mode: 'scenes' | 'book' };
}): Promise<string | 'coalesced' | null> {
	try {
		const boss = await getBoss();
		const jobId = await boss.send(ASSISTANT_ENRICH_QUEUE, input, {
			singletonKey: `details:${input.read.entityId}`,
			...assistantSendOptions(input.userId)
		});
		return jobId ?? 'coalesced';
	} catch (error) {
		logEvent('error', 'job.queue_failed', {
			queue: ASSISTANT_ENRICH_QUEUE,
			entityId: input.read.entityId,
			...errorFields(error)
		});
		return null;
	}
}

// Queues the job that writes one scene draft (the row it fills is staged
// first, see scene-drafts.ts). The singleton key holds one unfinished draft
// per scene.
export async function queueAssistantDraft(input: {
	// The id the job takes: the draft's row already carries it.
	jobId: string;
	userId: string;
	storyId: string;
	sceneId: string;
	draftId: string;
}): Promise<string | 'coalesced' | null> {
	try {
		const boss = await getBoss();
		const { jobId: id, ...data } = input;
		const jobId = await boss.send(ASSISTANT_DRAFT_QUEUE, data, {
			id,
			singletonKey: `draft:${input.sceneId}`,
			...assistantSendOptions(input.userId)
		});
		return jobId ?? 'coalesced';
	} catch (error) {
		logEvent('error', 'job.queue_failed', {
			queue: ASSISTANT_DRAFT_QUEUE,
			sceneId: input.sceneId,
			...errorFields(error)
		});
		return null;
	}
}

// Queues the one job that drafts a chapter's scenes in order (their rows are
// staged first, see scene-drafts.ts), on the scene draft queue. The singleton
// key holds one unfinished chapter draft per chapter.
export async function queueAssistantChapterDraft(input: {
	jobId: string;
	userId: string;
	storyId: string;
	chapterId: string;
	draftIds: string[];
	brief: string;
}): Promise<string | 'coalesced' | null> {
	try {
		const boss = await getBoss();
		const { jobId: id, ...data } = input;
		const jobId = await boss.send(ASSISTANT_DRAFT_QUEUE, data, {
			id,
			singletonKey: `draft-chapter:${input.chapterId}`,
			...assistantSendOptions(input.userId)
		});
		return jobId ?? 'coalesced';
	} catch (error) {
		logEvent('error', 'job.queue_failed', {
			queue: ASSISTANT_DRAFT_QUEUE,
			chapterId: input.chapterId,
			...errorFields(error)
		});
		return null;
	}
}

// What the queue says about a scene draft's job, for settling a draft whose
// job ended without settling it (see scene-drafts.ts). 'stopped' is the
// writer's Stop; 'missing' is a job the queue does not have (never queued, or
// long archived). A lookup that fails reads as running, so a draft still being
// written is never settled on a guess.
export async function assistantDraftJobState(
	id: string
): Promise<'running' | 'stopped' | 'done' | 'failed' | 'missing'> {
	try {
		const boss = await getBoss();
		const job = await boss.getJobById(ASSISTANT_DRAFT_QUEUE, id);
		if (!job) return 'missing';
		if (job.state === 'cancelled') return 'stopped';
		if (job.state === 'failed') return 'failed';
		if (job.state === 'completed') {
			return (job.output as { failed?: boolean } | null)?.failed ? 'failed' : 'done';
		}
		return 'running';
	} catch (error) {
		logEvent('error', 'job.state_failed', {
			queue: ASSISTANT_DRAFT_QUEUE,
			jobId: id,
			...errorFields(error)
		});
		return 'running';
	}
}

// Where the activity center's polling reads a queued Assistant job's progress.
// pg-boss archives a job once it settles, so a job it can no longer find by id
// is treated as done rather than lost.
export type AssistantJobState = 'running' | 'done' | 'failed';

// What the status endpoint reports for a review, which knows more than the
// queue does: a job pg-boss has forgotten while its recorded progress is still
// mid-run was dropped (a worker that died, a job that expired), so it is
// reported as stale rather than presented as a review that finished.
export type ReviewJobState = AssistantJobState | 'stale';

export function reviewJobState(
	state: AssistantJobState,
	phase: ReviewRunState['phase']
): ReviewJobState {
	return state === 'done' && phase !== 'done' ? 'stale' : state;
}

// The queues a job of each kind can be on, searched in order. LEGACY (#1041):
// a job queued before the upgrade is on the old review or summaries queue.
const JOB_QUEUES = {
	review: [ASSISTANT_REVIEW_QUEUE, LEGACY_ASSISTANT_REVIEW_QUEUE],
	summaries: [ASSISTANT_SUMMARIES_QUEUE, LEGACY_ASSISTANT_SUMMARIES_QUEUE],
	enrich: [ASSISTANT_ENRICH_QUEUE],
	arc: [ASSISTANT_ENRICH_QUEUE],
	details: [ASSISTANT_ENRICH_QUEUE],
	draft: [ASSISTANT_DRAFT_QUEUE]
} as const;

export async function getAssistantJobState(
	kind: keyof typeof JOB_QUEUES,
	id: string
): Promise<AssistantJobState> {
	const queues = JOB_QUEUES[kind];
	try {
		const boss = await getBoss();
		let job = null;
		for (const queue of queues) {
			job = await boss.getJobById(queue, id);
			if (job) break;
		}
		if (!job) return 'done';
		if (job.state === 'failed' || job.state === 'cancelled') return 'failed';
		// A run that settled itself as failed (see the worker's arc handler).
		if (job.state === 'completed') {
			return (job.output as { failed?: boolean } | null)?.failed ? 'failed' : 'done';
		}
		return 'running';
	} catch (error) {
		logEvent('error', 'job.state_failed', { queue: queues[0], jobId: id, ...errorFields(error) });
		return 'done';
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
		logEvent('error', 'job.queue_failed', { queue: MIGRATE_ASSETS_QUEUE, ...errorFields(error) });
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
		logEvent('error', 'backup.schedule_failed', { cron, ...errorFields(error) });
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
		logEvent('error', 'job.queue_failed', { queue: BACKUP_QUEUE, ...errorFields(error) });
		return false;
	}
}

// The signed-in writer's unsettled Assistant jobs, for a page loaded mid-run.
export async function listRunningAssistantJobs(userId: string): Promise<RunningAssistantJob[]> {
	try {
		return await findRunningAssistantJobs(db, userId);
	} catch (error) {
		logEvent('error', 'job.list_failed', { userId, ...errorFields(error) });
		return [];
	}
}

// Stops one of the signed-in writer's unsettled Assistant jobs (see
// stopAssistantJob). Null when the queue could not be reached.
export async function stopRunningAssistantJob(
	userId: string,
	jobId: string
): Promise<boolean | null> {
	try {
		return await stopAssistantJob(db, await getBoss(), userId, jobId);
	} catch (error) {
		logEvent('error', 'job.stop_failed', { userId, jobId, ...errorFields(error) });
		return null;
	}
}
