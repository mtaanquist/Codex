import { PgBoss } from 'pg-boss';
import {
	BACKUP_QUEUE,
	EMAIL_QUEUE,
	EXPORT_ARTIFACTS_QUEUE,
	MENTIONS_SCENE_QUEUE,
	MENTIONS_UNIVERSE_QUEUE,
	NOTIFICATION_DIGEST_QUEUE,
	PURGE_ACCOUNTS_QUEUE,
	PURGE_UNIVERSES_QUEUE,
	RECONCILE_MENTIONS_QUEUE,
	REVIEWER_DIGEST_QUEUE
} from '../lib/server/queues.ts';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../lib/server/db/schema.ts';
import {
	rebuildSceneMentions,
	rebuildUniverseMentions,
	reconcileMentions
} from '../lib/server/mentions.ts';
import { generateEditionArtifacts } from '../lib/server/export-artifacts.ts';
import { backupConfig, runBackup } from '../lib/server/backups.ts';
import { sendEmail, type EmailMessage } from '../lib/server/email.ts';
import {
	buildReviewerDigest,
	buildUserDigest,
	markEmailed,
	markReviewerNotified
} from '../lib/server/notification-digest.ts';
import { listAccountsDueForPurge, purgeAccount } from '../lib/server/account-deletion.ts';
import {
	listUniversesDueForPurge,
	purgeUniverseWithin,
	universeAssetKeys
} from '../lib/server/universe-lifecycle.ts';
import { assetConfig, s3AssetStore } from '../lib/server/assets.ts';

// Background job processor. Runs directly under Node's native TypeScript
// support, so there is no build step; relative imports carry .ts extensions.
const connectionString = process.env.DATABASE_URL ?? 'postgres://codex:codex@localhost:5432/codex';

const db = drizzle(new pg.Pool({ connectionString }), { schema });
const boss = new PgBoss(connectionString);

boss.on('error', (error) => {
	console.error('pg-boss error:', error);
});

await boss.start();
await boss.createQueue(MENTIONS_SCENE_QUEUE);
await boss.createQueue(MENTIONS_UNIVERSE_QUEUE);
await boss.createQueue(RECONCILE_MENTIONS_QUEUE);
await boss.createQueue(EXPORT_ARTIFACTS_QUEUE);
await boss.createQueue(BACKUP_QUEUE);
await boss.createQueue(EMAIL_QUEUE);
await boss.createQueue(PURGE_ACCOUNTS_QUEUE);
await boss.createQueue(PURGE_UNIVERSES_QUEUE);
await boss.createQueue(NOTIFICATION_DIGEST_QUEUE);
await boss.createQueue(REVIEWER_DIGEST_QUEUE);

await boss.work<{ sceneId: string }>(MENTIONS_SCENE_QUEUE, async (jobs) => {
	for (const job of jobs) {
		const result = await rebuildSceneMentions(db, job.data.sceneId);
		if (result.ok) console.log(`mentions: scene ${job.data.sceneId} -> ${result.count}`);
		else console.warn(`mentions: scene ${job.data.sceneId} skipped (${result.reason})`);
	}
});

await boss.work<{ universeId: string }>(MENTIONS_UNIVERSE_QUEUE, async (jobs) => {
	for (const job of jobs) {
		const count = await rebuildUniverseMentions(db, job.data.universeId);
		console.log(`mentions: universe ${job.data.universeId} -> ${count} scenes reindexed`);
	}
});

// Backstop for any rebuild job that was dropped (a failed enqueue, or a worker
// restart mid-job): re-index scenes whose mention watermark has fallen behind.
await boss.work(RECONCILE_MENTIONS_QUEUE, async () => {
	const reindexed = await reconcileMentions(db);
	if (reindexed > 0) console.log(`mentions: reconcile reindexed ${reindexed} stale scene(s)`);
});

// Generates the stored export files (markdown zip, EPUB, PDF) for a freshly
// published edition. Formats fail independently, so a PDF problem still
// leaves the zip and EPUB downloadable.
await boss.work<{ publicationId: string }>(EXPORT_ARTIFACTS_QUEUE, async (jobs) => {
	for (const job of jobs) {
		const result = await generateEditionArtifacts(db, job.data.publicationId);
		if (!result.ok) {
			console.warn(`exports: edition ${job.data.publicationId} skipped (${result.reason})`);
			continue;
		}
		console.log(`exports: edition ${job.data.publicationId} -> ${result.stored.join(', ')}`);
		for (const failure of result.failed) {
			console.error(
				`exports: edition ${job.data.publicationId} ${failure.format} failed: ${failure.error}`
			);
		}
	}
});

await boss.work<{ trigger?: 'scheduled' | 'manual' }>(BACKUP_QUEUE, async (jobs) => {
	for (const job of jobs) {
		const result = await runBackup(db, job.data.trigger ?? 'scheduled');
		if (!result.ok) console.error(`backup: failed (${result.reason})`);
		else if (result.skipped) console.log('backup: skipped, nothing changed');
		else console.log(`backup: uploaded ${result.key}`);
	}
});

await boss.work<EmailMessage>(EMAIL_QUEUE, async (jobs) => {
	for (const job of jobs) {
		await sendEmail(db, job.data);
		console.log(`email: sent to ${job.data.to} (${job.data.subject})`);
	}
});

// Notification digests: one email per recipient gathering everything that
// arrived since the last one. Links in the email need an absolute origin.
const origin = process.env.ORIGIN ?? 'http://localhost:5173';

await boss.work<{ userId: string }>(NOTIFICATION_DIGEST_QUEUE, async (jobs) => {
	for (const job of jobs) {
		const digest = await buildUserDigest(db, job.data.userId, origin);
		if (!digest) continue;
		await sendEmail(db, digest.email);
		await markEmailed(db, digest.ids);
		console.log(`notify: digest of ${digest.ids.length} sent to user ${job.data.userId}`);
	}
});

await boss.work<{ reviewerId: string }>(REVIEWER_DIGEST_QUEUE, async (jobs) => {
	for (const job of jobs) {
		const digest = await buildReviewerDigest(db, job.data.reviewerId, origin);
		if (!digest) continue;
		await sendEmail(db, digest.email);
		await markReviewerNotified(db, digest.reviewerId, digest.upTo);
		console.log(`notify: reviewer digest sent for ${job.data.reviewerId}`);
	}
});

await boss.work(PURGE_ACCOUNTS_QUEUE, async () => {
	const due = await listAccountsDueForPurge(db);
	if (due.length === 0) return;
	const config = assetConfig();
	const store = config ? s3AssetStore(config) : null;
	for (const userId of due) {
		try {
			await purgeAccount(db, userId, store);
			console.log(`purge: account ${userId} deleted`);
		} catch (error) {
			console.error(`purge: account ${userId} failed`, error);
		}
	}
});

// Trashed universes past their restore window go for good.
await boss.work(PURGE_UNIVERSES_QUEUE, async () => {
	const due = await listUniversesDueForPurge(db);
	if (due.length === 0) return;
	const config = assetConfig();
	const store = config ? s3AssetStore(config) : null;
	for (const universeId of due) {
		try {
			const keys = await universeAssetKeys(db, universeId);
			await db.transaction((tx) => purgeUniverseWithin(tx, universeId));
			if (store) for (const key of keys) await store.remove(key).catch(() => {});
			console.log(`purge: universe ${universeId} deleted`);
		} catch (error) {
			console.error(`purge: universe ${universeId} failed`, error);
		}
	}
});

// Run the account purge sweep hourly; accounts past their grace window go.
await boss.schedule(PURGE_ACCOUNTS_QUEUE, '30 * * * *', {}, { tz: 'UTC' });

// And the universe trash sweep, offset from the account one.
await boss.schedule(PURGE_UNIVERSES_QUEUE, '45 * * * *', {}, { tz: 'UTC' });

// Sweep for stale mention indexes every five minutes, so a dropped rebuild
// self-heals within minutes instead of waiting for the next save.
await boss.schedule(RECONCILE_MENTIONS_QUEUE, '*/5 * * * *', {}, { tz: 'UTC' });

// Nightly off-site backups, only when the bucket is configured. The
// schedule lives in pg-boss, so it is cleared when configuration goes away.
const backups = backupConfig();
if (backups) {
	await boss.schedule(BACKUP_QUEUE, backups.cron, { trigger: 'scheduled' }, { tz: 'UTC' });
	console.log(
		`backups: scheduled (${backups.cron} UTC; keep ${backups.keepRecentHours}h full, ${backups.keepDays}d daily)`
	);
} else {
	await boss.unschedule(BACKUP_QUEUE);
}

console.log('Worker started; processing mention rebuilds.');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => {
		void boss.stop().then(() => process.exit(0));
	});
}
