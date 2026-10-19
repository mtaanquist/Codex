import { PgBoss } from 'pg-boss';
import {
	BACKUP_QUEUE,
	EMAIL_QUEUE,
	EMAIL_DEAD_LETTER_QUEUE,
	EXPORT_ARTIFACTS_QUEUE,
	MENTIONS_SCENE_QUEUE,
	MENTIONS_UNIVERSE_QUEUE,
	MIGRATE_ASSETS_QUEUE,
	NOTIFICATION_DIGEST_QUEUE,
	PURGE_ACCOUNTS_QUEUE,
	PURGE_REVIEW_RUNS_QUEUE,
	PURGE_SESSIONS_QUEUE,
	PURGE_UNIVERSES_QUEUE,
	THIN_REVISIONS_QUEUE,
	SWEEP_DELETED_OBJECTS_QUEUE,
	RECONCILE_MENTIONS_QUEUE,
	REVIEWER_DIGEST_QUEUE,
	USER_EXPORT_QUEUE,
	ASSISTANT_JOB_CONCURRENCY,
	ASSISTANT_REVIEW_QUEUE,
	ASSISTANT_SUMMARIES_QUEUE
} from '../lib/server/queues.ts';
import { createPool } from '../lib/server/db/pool.ts';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../lib/server/db/schema.ts';
import { backupConfig, effectiveBackupConfig } from '../lib/server/backups.ts';
import { createHandlers } from './handlers.ts';
import { stopWorker } from './shutdown.ts';
import { resolveOrigin } from '../lib/server/origin-rule.ts';
import { errorFields, logEvent } from '../lib/server/log.ts';

// Background job processor. Runs directly under Node's native TypeScript
// support, so there is no build step; relative imports carry .ts extensions.
// Digest links need an absolute origin. Like the app, the worker refuses to
// start without ORIGIN outside development.
const origin = resolveOrigin(
	process.env.ORIGIN,
	'http://localhost:5173',
	process.env.NODE_ENV !== 'production'
);

const connectionString = process.env.DATABASE_URL ?? 'postgres://codex:codex@localhost:5432/codex';

// Jobs run longer statements than web requests (purges, reindexing), so the
// per-statement limit is looser than the app's.
const db = drizzle(createPool(connectionString, { statementTimeoutMs: 300_000 }), { schema });
const boss = new PgBoss(connectionString);

const handlers = createHandlers({ db, boss, origin });

boss.on('error', (error) => {
	logEvent('error', 'pgboss.error', errorFields(error));
});

await boss.start();
await boss.createQueue(MENTIONS_SCENE_QUEUE);
await boss.createQueue(MENTIONS_UNIVERSE_QUEUE);
await boss.createQueue(RECONCILE_MENTIONS_QUEUE);
await boss.createQueue(EXPORT_ARTIFACTS_QUEUE);
await boss.createQueue(BACKUP_QUEUE);
await boss.createQueue(EMAIL_QUEUE);
await boss.createQueue(EMAIL_DEAD_LETTER_QUEUE);
await boss.createQueue(PURGE_ACCOUNTS_QUEUE);
await boss.createQueue(PURGE_UNIVERSES_QUEUE);
await boss.createQueue(SWEEP_DELETED_OBJECTS_QUEUE);
await boss.createQueue(PURGE_REVIEW_RUNS_QUEUE);
await boss.createQueue(THIN_REVISIONS_QUEUE);
await boss.createQueue(PURGE_SESSIONS_QUEUE);
await boss.createQueue(NOTIFICATION_DIGEST_QUEUE);
await boss.createQueue(REVIEWER_DIGEST_QUEUE);
await boss.createQueue(MIGRATE_ASSETS_QUEUE);
await boss.createQueue(USER_EXPORT_QUEUE);
await boss.createQueue(ASSISTANT_REVIEW_QUEUE);
await boss.createQueue(ASSISTANT_SUMMARIES_QUEUE);

// Assistant jobs run several at once, but one per writer (the job's group),
// so one writer's slow or hung endpoint does not hold up anyone else. The
// metadata carries the start time and retry count shouldNotifyWriter reads.
const ASSISTANT_WORK_OPTIONS = {
	localConcurrency: ASSISTANT_JOB_CONCURRENCY,
	localGroupConcurrency: 1,
	includeMetadata: true as const
};

await boss.work(MENTIONS_SCENE_QUEUE, handlers.mentionsScene);
await boss.work(MENTIONS_UNIVERSE_QUEUE, handlers.mentionsUniverse);
await boss.work(RECONCILE_MENTIONS_QUEUE, handlers.reconcileMentions);
await boss.work(EXPORT_ARTIFACTS_QUEUE, handlers.exportArtifacts);
await boss.work(MIGRATE_ASSETS_QUEUE, handlers.migrateAssets);
await boss.work(USER_EXPORT_QUEUE, handlers.userExport);
await boss.work(ASSISTANT_REVIEW_QUEUE, ASSISTANT_WORK_OPTIONS, handlers.assistantReview);
await boss.work(ASSISTANT_SUMMARIES_QUEUE, ASSISTANT_WORK_OPTIONS, handlers.assistantSummaries);
await boss.work(BACKUP_QUEUE, handlers.backup);
await boss.work(EMAIL_QUEUE, handlers.email);
await boss.work(EMAIL_DEAD_LETTER_QUEUE, handlers.emailDeadLetter);
await boss.work(NOTIFICATION_DIGEST_QUEUE, handlers.notificationDigest);
await boss.work(REVIEWER_DIGEST_QUEUE, handlers.reviewerDigest);
await boss.work(PURGE_ACCOUNTS_QUEUE, handlers.purgeAccounts);
await boss.work(PURGE_UNIVERSES_QUEUE, handlers.purgeUniverses);
await boss.work(SWEEP_DELETED_OBJECTS_QUEUE, handlers.sweepDeletedObjects);
await boss.work(PURGE_REVIEW_RUNS_QUEUE, handlers.purgeReviewRuns);
await boss.work(THIN_REVISIONS_QUEUE, handlers.thinRevisions);
await boss.work(PURGE_SESSIONS_QUEUE, handlers.purgeSessions);

// Run the account purge sweep hourly; accounts past their grace window go.
await boss.schedule(PURGE_ACCOUNTS_QUEUE, '30 * * * *', {}, { tz: 'UTC' });

// And the universe trash sweep, offset from the account one.
await boss.schedule(PURGE_UNIVERSES_QUEUE, '45 * * * *', {}, { tz: 'UTC' });

await boss.schedule(SWEEP_DELETED_OBJECTS_QUEUE, '0 4 * * *', {}, { tz: 'UTC' });

// Old review progress goes once a day; nothing is time critical about it.
await boss.schedule(PURGE_REVIEW_RUNS_QUEUE, '15 4 * * *', {}, { tz: 'UTC' });

// Old autosave history is thinned once a day, after the review-run sweep.
await boss.schedule(THIN_REVISIONS_QUEUE, '35 4 * * *', {}, { tz: 'UTC' });

// Expired and long-revoked sessions go once a day.
await boss.schedule(PURGE_SESSIONS_QUEUE, '50 4 * * *', {}, { tz: 'UTC' });

// Sweep for stale mention indexes every five minutes, so a dropped rebuild
// self-heals within minutes instead of waiting for the next save.
await boss.schedule(RECONCILE_MENTIONS_QUEUE, '*/5 * * * *', {}, { tz: 'UTC' });

// Off-site backups, only when the bucket is configured (saved settings or
// environment). The schedule lives in pg-boss, so it is cleared when the
// configuration goes away; the app re-applies it when settings are saved.
// A failed settings read falls back to the environment instead of crashing
// the process; the next start reconciles fully.
const backups = await effectiveBackupConfig(db).catch((error) => {
	logEvent('warn', 'backup.settings_failed', errorFields(error));
	return backupConfig();
});
if (backups) {
	await boss.schedule(BACKUP_QUEUE, backups.cron, { trigger: 'scheduled' }, { tz: 'UTC' });
	logEvent('info', 'backup.scheduled', {
		cron: backups.cron,
		keepRecentHours: backups.keepRecentHours,
		keepDays: backups.keepDays
	});
} else {
	await boss.unschedule(BACKUP_QUEUE);
}

logEvent('info', 'worker.started');

// Running jobs get until the stop timeout to finish; then pg-boss fails them
// into a retry so they are picked up again on the next start.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => {
		logEvent('info', 'worker.stopping', { signal });
		void stopWorker(boss).then(
			() => process.exit(0),
			(error) => {
				logEvent('error', 'worker.stop_failed', errorFields(error));
				process.exit(1);
			}
		);
	});
}
