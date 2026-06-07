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
export const EXPORT_ARTIFACTS_QUEUE = 'export-artifacts';
export const NOTIFICATION_DIGEST_QUEUE = 'notification-digest';
export const REVIEWER_DIGEST_QUEUE = 'reviewer-digest';
export const PURGE_ACCOUNTS_QUEUE = 'purge-accounts';
export const PURGE_UNIVERSES_QUEUE = 'purge-universes';
export const MIGRATE_ASSETS_QUEUE = 'migrate-assets';
