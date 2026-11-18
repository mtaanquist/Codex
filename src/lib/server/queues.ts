// pg-boss queue names, the one list both sides import: the app's send-only
// handle (jobs.ts) and the worker's createQueue/work calls. jobs.ts cannot
// be imported by the worker (it reads $env), which is how the names ended
// up duplicated as literals and free to drift; this module has no imports
// at all, so it is safe everywhere.
export const MENTIONS_SCENE_QUEUE = 'mentions-scene';
export const MENTIONS_UNIVERSE_QUEUE = 'mentions-universe';
export const RECONCILE_MENTIONS_QUEUE = 'reconcile-mentions';
export const BACKUP_QUEUE = 'run-backup';
export const EMAIL_QUEUE = 'send-email';
// Transactional emails that exhaust their retries land here so an operator
// can see what was dropped instead of it vanishing into pg-boss's failed rows.
export const EMAIL_DEAD_LETTER_QUEUE = 'send-email-dead-letter';
export const EXPORT_ARTIFACTS_QUEUE = 'export-artifacts';
export const USER_EXPORT_QUEUE = 'user-export';
export const NOTIFICATION_DIGEST_QUEUE = 'notification-digest';
export const REVIEWER_DIGEST_QUEUE = 'reviewer-digest';
export const PURGE_ACCOUNTS_QUEUE = 'purge-accounts';
export const PURGE_UNIVERSES_QUEUE = 'purge-universes';
// Removes bucket objects whose rows were deleted longer ago than the backup
// retention window (see sweepDeletedObjects in assets.ts).
export const SWEEP_DELETED_OBJECTS_QUEUE = 'sweep-deleted-objects';
export const MIGRATE_ASSETS_QUEUE = 'migrate-assets';
// The Assistant queues are exclusive: one queued or running job per
// singletonKey (a review scope, a story's summary pass, a universe's enrichment,
// one character's arc). Under pg-boss's default policy a singletonKey does not
// stop a second job. A policy cannot change after the queue exists, which is why
// review and summaries moved to new names (#986).
export const ASSISTANT_QUEUE_OPTIONS = { policy: 'exclusive' } as const;
export const ASSISTANT_REVIEW_QUEUE = 'assistant-review-v2';
export const ASSISTANT_SUMMARIES_QUEUE = 'assistant-summaries-v2';
export const ASSISTANT_ENRICH_QUEUE = 'assistant-enrich';
// LEGACY, remove in a later release (#1041): the default-policy queues
// review and summaries used before #986. Nothing sends to them any more; the
// worker drains jobs queued there before the upgrade, and the job lookups
// (status polling, running jobs) still read them until they are empty.
export const LEGACY_ASSISTANT_REVIEW_QUEUE = 'assistant-review';
export const LEGACY_ASSISTANT_SUMMARIES_QUEUE = 'assistant-summaries';
// Sweeps the recorded progress of long-finished Assistant runs (see
// review-runs.ts); the rows are disposable, so nothing is lost with them.
export const PURGE_REVIEW_RUNS_QUEUE = 'purge-review-runs';
// Deletes expired and long-revoked sessions (see purgeSessions in auth.ts).
export const PURGE_SESSIONS_QUEUE = 'purge-sessions';

// pg-boss expires an active job after 15 minutes by default and hands it to a
// worker again, so a long Assistant run would be started a second time while
// the first is still going: the same scenes billed twice, and two executions
// writing the same run state. A story review is minutes per scene on local
// hardware, so these jobs are given six hours instead. A run whose worker
// genuinely died misses its heartbeat and is retried (resuming through the
// recorded progress).
export const ASSISTANT_JOB_EXPIRY_SECONDS = 6 * 60 * 60;
// The worker refreshes a running job's heartbeat every half of this; a job
// whose worker stops refreshing (killed, crashed) is failed and retried within
// about a minute instead of sitting active until it expires. Used by the long
// jobs: Assistant runs and exports.
export const JOB_HEARTBEAT_SECONDS = 60;
// Assistant jobs the worker runs at once, across writers. Each writer still
// gets one at a time (see assistantSendOptions in jobs.ts).
export const ASSISTANT_JOB_CONCURRENCY = 4;

// How long a notification digest waits before sending, so a busy thread
// lands as one email instead of one per comment. Lives here (not jobs.ts,
// which reads $env) so the worker can import it too.
export const DIGEST_DELAY_SECONDS = 600;
