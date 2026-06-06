import { PgBoss } from 'pg-boss';
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
await boss.createQueue('mentions-scene');
await boss.createQueue('mentions-universe');
await boss.createQueue('reconcile-mentions');
await boss.createQueue('export-artifacts');
await boss.createQueue('run-backup');
await boss.createQueue('send-email');
await boss.createQueue('purge-accounts');
await boss.createQueue('purge-universes');
await boss.createQueue('notification-digest');
await boss.createQueue('reviewer-digest');

await boss.work<{ sceneId: string }>('mentions-scene', async (jobs) => {
	for (const job of jobs) {
		const result = await rebuildSceneMentions(db, job.data.sceneId);
		if (result.ok) console.log(`mentions: scene ${job.data.sceneId} -> ${result.count}`);
		else console.warn(`mentions: scene ${job.data.sceneId} skipped (${result.reason})`);
	}
});

await boss.work<{ universeId: string }>('mentions-universe', async (jobs) => {
	for (const job of jobs) {
		const count = await rebuildUniverseMentions(db, job.data.universeId);
		console.log(`mentions: universe ${job.data.universeId} -> ${count} scenes reindexed`);
	}
});

// Backstop for any rebuild job that was dropped (a failed enqueue, or a worker
// restart mid-job): re-index scenes whose mention watermark has fallen behind.
await boss.work('reconcile-mentions', async () => {
	const reindexed = await reconcileMentions(db);
	if (reindexed > 0) console.log(`mentions: reconcile reindexed ${reindexed} stale scene(s)`);
});

// Generates the stored export files (markdown zip, EPUB, PDF) for a freshly
// published edition. Formats fail independently, so a PDF problem still
// leaves the zip and EPUB downloadable.
await boss.work<{ publicationId: string }>('export-artifacts', async (jobs) => {
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

await boss.work<{ trigger?: 'scheduled' | 'manual' }>('run-backup', async (jobs) => {
	for (const job of jobs) {
		const result = await runBackup(db, job.data.trigger ?? 'scheduled');
		if (!result.ok) console.error(`backup: failed (${result.reason})`);
		else if (result.skipped) console.log('backup: skipped, nothing changed');
		else console.log(`backup: uploaded ${result.key}`);
	}
});

await boss.work<EmailMessage>('send-email', async (jobs) => {
	for (const job of jobs) {
		await sendEmail(db, job.data);
		console.log(`email: sent to ${job.data.to} (${job.data.subject})`);
	}
});

// Notification digests: one email per recipient gathering everything that
// arrived since the last one. Links in the email need an absolute origin.
const origin = process.env.ORIGIN ?? 'http://localhost:5173';

await boss.work<{ userId: string }>('notification-digest', async (jobs) => {
	for (const job of jobs) {
		const digest = await buildUserDigest(db, job.data.userId, origin);
		if (!digest) continue;
		await sendEmail(db, digest.email);
		await markEmailed(db, digest.ids);
		console.log(`notify: digest of ${digest.ids.length} sent to user ${job.data.userId}`);
	}
});

await boss.work<{ reviewerId: string }>('reviewer-digest', async (jobs) => {
	for (const job of jobs) {
		const digest = await buildReviewerDigest(db, job.data.reviewerId, origin);
		if (!digest) continue;
		await sendEmail(db, digest.email);
		await markReviewerNotified(db, digest.reviewerId, digest.upTo);
		console.log(`notify: reviewer digest sent for ${job.data.reviewerId}`);
	}
});

await boss.work('purge-accounts', async () => {
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
await boss.work('purge-universes', async () => {
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
await boss.schedule('purge-accounts', '30 * * * *', {}, { tz: 'UTC' });

// And the universe trash sweep, offset from the account one.
await boss.schedule('purge-universes', '45 * * * *', {}, { tz: 'UTC' });

// Sweep for stale mention indexes every five minutes, so a dropped rebuild
// self-heals within minutes instead of waiting for the next save.
await boss.schedule('reconcile-mentions', '*/5 * * * *', {}, { tz: 'UTC' });

// Nightly off-site backups, only when the bucket is configured. The
// schedule lives in pg-boss, so it is cleared when configuration goes away.
const backups = backupConfig();
if (backups) {
	await boss.schedule('run-backup', backups.cron, { trigger: 'scheduled' }, { tz: 'UTC' });
	console.log(
		`backups: scheduled (${backups.cron} UTC; keep ${backups.keepRecentHours}h full, ${backups.keepDays}d daily)`
	);
} else {
	await boss.unschedule('run-backup');
}

console.log('Worker started; processing mention rebuilds.');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => {
		void boss.stop().then(() => process.exit(0));
	});
}
