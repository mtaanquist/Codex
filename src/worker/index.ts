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
	PURGE_UNIVERSES_QUEUE,
	RECONCILE_MENTIONS_QUEUE,
	REVIEWER_DIGEST_QUEUE,
	ASSISTANT_REVIEW_QUEUE,
	ASSISTANT_SUMMARIES_QUEUE
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
import { backupConfig, effectiveBackupConfig, runBackup } from '../lib/server/backups.ts';
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
import {
	assetMigrationSource,
	clearAssetMigrationSource,
	effectiveAssetConfig,
	migrateAssetObjects,
	recordAssetMigrationResult,
	s3AssetStore
} from '../lib/server/assets.ts';
import { reviewStoryScenes } from '../lib/server/llm/scene-review.ts';
import { summariseStory } from '../lib/server/llm/summaries.ts';
import { insertNotifications } from '../lib/server/notify-core.ts';
import { eq } from 'drizzle-orm';

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
await boss.createQueue(EMAIL_DEAD_LETTER_QUEUE);
await boss.createQueue(PURGE_ACCOUNTS_QUEUE);
await boss.createQueue(PURGE_UNIVERSES_QUEUE);
await boss.createQueue(NOTIFICATION_DIGEST_QUEUE);
await boss.createQueue(REVIEWER_DIGEST_QUEUE);
await boss.createQueue(MIGRATE_ASSETS_QUEUE);
await boss.createQueue(ASSISTANT_REVIEW_QUEUE);
await boss.createQueue(ASSISTANT_SUMMARIES_QUEUE);

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

// Copies every stored asset and export file from the stashed previous
// storage to the current one, after the admin re-points asset storage and
// asks for the copy. Failures leave the stash in place for another run.
await boss.work(MIGRATE_ASSETS_QUEUE, async () => {
	const source = await assetMigrationSource(db);
	const target = await effectiveAssetConfig(db);
	if (!source || !target) {
		console.warn('asset migration: no stashed source or no storage configured, skipping');
		return;
	}
	const result = await migrateAssetObjects(db, s3AssetStore(source), s3AssetStore(target));
	await recordAssetMigrationResult(db, { finishedAt: new Date().toISOString(), ...result });
	if (result.failed === 0) await clearAssetMigrationSource(db);
	console.log(`asset migration: ${result.copied} copied, ${result.failed} failed`);
});

// Whole-story or single-chapter Assistant review: fan over the scenes in scope,
// stage the Assistant's notes through the review tools, then tell the owner it
// is ready (or that the endpoint could not be reached). Matches the inline
// single-scene endpoint, just unattended and over many scenes.
await boss.work<{ userId: string; storyId: string; chapterId?: string }>(
	ASSISTANT_REVIEW_QUEUE,
	async (jobs) => {
		for (const job of jobs) {
			const { userId, storyId, chapterId } = job.data;
			const [story] = await db
				.select({
					ownerId: schema.stories.ownerId,
					title: schema.stories.title,
					slug: schema.stories.slug
				})
				.from(schema.stories)
				.where(eq(schema.stories.id, storyId));
			// Re-check ownership at run time: the story may have been deleted since.
			if (!story || story.ownerId !== userId) {
				console.warn(`assistant review: story ${storyId} not owned by ${userId}, skipping`);
				continue;
			}
			const result = await reviewStoryScenes(db, { userId, storyId, chapterId });
			const href = `/stories/${story.slug}/review`;
			let title: string;
			if (result.reviewed === 0 && result.failed > 0) {
				title = `The Assistant could not review "${story.title}". Check the endpoint in your settings.`;
			} else if (result.notes === 0) {
				title = `The Assistant reviewed "${story.title}" and had no notes to add.`;
			} else {
				title = `The Assistant left ${result.notes} note${result.notes === 1 ? '' : 's'} on "${story.title}".`;
			}
			const digestUsers = await insertNotifications(db, [userId], 'assistant_review', {
				title,
				href
			});
			// Queue the recipient's batched email; 600s matches jobs.ts
			// DIGEST_DELAY_SECONDS (not importable here - jobs.ts reads $env).
			for (const id of digestUsers) {
				await boss.send(
					NOTIFICATION_DIGEST_QUEUE,
					{ userId: id },
					{ startAfter: 600, singletonKey: id }
				);
			}
			console.log(
				`assistant review: story ${storyId} - ${result.reviewed} reviewed, ${result.failed} failed, ${result.notes} notes`
			);
		}
	}
);

// Whole-story summary maintenance: draft and refresh scene and chapter
// summaries (the metadata that feeds recap and context). Owner re-checked at run
// time; the writer is notified when it is done. Like the review job, the gateway
// is called directly with no HTTP hop.
await boss.work<{ userId: string; storyId: string }>(ASSISTANT_SUMMARIES_QUEUE, async (jobs) => {
	for (const job of jobs) {
		const { userId, storyId } = job.data;
		const [story] = await db
			.select({
				ownerId: schema.stories.ownerId,
				title: schema.stories.title,
				slug: schema.stories.slug
			})
			.from(schema.stories)
			.where(eq(schema.stories.id, storyId));
		if (!story || story.ownerId !== userId) {
			console.warn(`assistant summaries: story ${storyId} not owned by ${userId}, skipping`);
			continue;
		}
		const result = await summariseStory(db, { userId, storyId });
		const written = result.scenes + result.chapters;
		const href = `/stories/${story.slug}`;
		let title: string;
		if (written === 0 && result.failed > 0) {
			title = `The Assistant could not summarise "${story.title}". Check the endpoint in your settings.`;
		} else if (written === 0) {
			title = `The Assistant found nothing to summarise in "${story.title}".`;
		} else {
			title = `The Assistant updated ${written} ${written === 1 ? 'summary' : 'summaries'} in "${story.title}".`;
		}
		const digestUsers = await insertNotifications(db, [userId], 'assistant_summaries', {
			title,
			href
		});
		for (const id of digestUsers) {
			await boss.send(
				NOTIFICATION_DIGEST_QUEUE,
				{ userId: id },
				{ startAfter: 600, singletonKey: id }
			);
		}
		console.log(
			`assistant summaries: story ${storyId} - ${result.scenes} scenes, ${result.chapters} chapters, ${result.failed} failed`
		);
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

// Transactional email that exhausted its retries (a prolonged SMTP outage).
// The send is given up, but it must not vanish: log it loudly so an operator
// can resend by hand. The recipient flow already said "check your email", so
// there is no other signal otherwise.
await boss.work<EmailMessage>(EMAIL_DEAD_LETTER_QUEUE, async (jobs) => {
	for (const job of jobs) {
		console.error(
			`email: DROPPED after retries - to ${job.data.to} (${job.data.subject}); SMTP likely down`
		);
	}
});

// Notification digests: one email per recipient gathering everything that
// arrived since the last one. Links in the email need an absolute origin.
const origin = process.env.ORIGIN ?? 'http://localhost:5173';

await boss.work<{ userId: string }>(NOTIFICATION_DIGEST_QUEUE, async (jobs) => {
	for (const job of jobs) {
		const digest = await buildUserDigest(db, job.data.userId, origin);
		if (!digest) continue;
		// Mark the rows emailed before sending: a job retry after a crash then
		// finds nothing to send rather than mailing the digest twice. The cost
		// is that a hard send failure drops one digest, which the next
		// notification re-forms; an un-recallable duplicate is the worse outcome.
		await markEmailed(db, digest.ids);
		await sendEmail(db, digest.email);
		console.log(`notify: digest of ${digest.ids.length} sent to user ${job.data.userId}`);
	}
});

await boss.work<{ reviewerId: string }>(REVIEWER_DIGEST_QUEUE, async (jobs) => {
	for (const job of jobs) {
		const digest = await buildReviewerDigest(db, job.data.reviewerId, origin);
		if (!digest) continue;
		// Advance the watermark before sending, for the same reason as the user
		// digest above: a retry must not re-send, even at the cost of dropping a
		// digest on a hard send failure.
		await markReviewerNotified(db, digest.reviewerId, digest.upTo);
		await sendEmail(db, digest.email);
		console.log(`notify: reviewer digest sent for ${job.data.reviewerId}`);
	}
});

await boss.work(PURGE_ACCOUNTS_QUEUE, async () => {
	const due = await listAccountsDueForPurge(db);
	if (due.length === 0) return;
	const config = await effectiveAssetConfig(db);
	const store = config ? s3AssetStore(config) : null;
	for (const userId of due) {
		try {
			await purgeAccount(db, userId, store, { requireSchedule: true });
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
	const config = await effectiveAssetConfig(db);
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

// Off-site backups, only when the bucket is configured (saved settings or
// environment). The schedule lives in pg-boss, so it is cleared when the
// configuration goes away; the app re-applies it when settings are saved.
// On a fresh stack the worker can boot while the app is still running the
// migrations, so a failed settings read falls back to the environment
// instead of crashing the process; the next start reconciles fully.
const backups = await effectiveBackupConfig(db).catch((error) => {
	console.warn('backups: could not read saved settings, using the environment:', error);
	return backupConfig();
});
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
