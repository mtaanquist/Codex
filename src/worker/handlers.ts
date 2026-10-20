import type { Job, JobWithMetadata, PgBoss } from 'pg-boss';
import { eq } from 'drizzle-orm';
import {
	ASSISTANT_REVIEW_QUEUE,
	ASSISTANT_SUMMARIES_QUEUE,
	DIGEST_DELAY_SECONDS,
	NOTIFICATION_DIGEST_QUEUE
} from '../lib/server/queues.ts';
import * as schema from '../lib/server/db/schema.ts';
import type { Database } from '../lib/server/auth.ts';
import {
	rebuildSceneMentions,
	rebuildUniverseMentions,
	reconcileMentions
} from '../lib/server/mentions.ts';
import { generateEditionArtifacts } from '../lib/server/export-artifacts.ts';
import { pruneOwnerExports, runUserExport } from '../lib/server/user-exports.ts';
import { effectiveBackupConfig, runBackup } from '../lib/server/backups.ts';
import { sendEmail } from '../lib/server/email.ts';
import { resolveEmailJob, type EmailJob } from '../lib/server/token-email.ts';
import { errorFields, logEvent, redactEmail } from '../lib/server/log.ts';
import {
	buildReviewerDigest,
	buildUserDigest,
	markEmailed,
	markReviewerNotified
} from '../lib/server/notification-digest.ts';
import { listAccountsDueForPurge, purgeAccount } from '../lib/server/account-deletion.ts';
import { listUniversesDueForPurge, purgeUniverse } from '../lib/server/universe-lifecycle.ts';
import { listStoriesDueForPurge } from '../lib/server/story-lifecycle.ts';
import { purgeStory } from '../lib/server/story-delete.ts';
import {
	assetMigrationSource,
	clearAssetMigrationSource,
	effectiveAssetConfig,
	migrateAssetObjects,
	objectDeletionGraceDays,
	recordAssetMigrationResult,
	s3AssetStore,
	sweepDeletedObjects
} from '../lib/server/assets.ts';
import {
	failureMessage,
	reviewStoryScenes,
	reviewStoryContinuity,
	reviewUniverseContinuity
} from '../lib/server/llm/scene-review.ts';
import type { ReviewFailure } from '../lib/server/db/schema.ts';
import type { ReviewCategory } from '../lib/review-shape.ts';
import { summariseStory } from '../lib/server/llm/summaries.ts';
import { purgeReviewRuns } from '../lib/server/review-runs.ts';
import { purgeSessions } from '../lib/server/auth.ts';
import { insertNotifications } from '../lib/server/notify-core.ts';
import { shouldNotifyWriter } from './job-guard.ts';

// The job handlers, kept apart from index.ts (which owns the pg-boss
// connection, queue setup and schedules) so tests can run them directly.

// The calls that reach outside the database (the Assistant endpoint, SMTP,
// the bucket). Tests swap them; the worker uses the real ones.
const defaultServices = {
	reviewStoryScenes,
	reviewStoryContinuity,
	reviewUniverseContinuity,
	summariseStory,
	sendEmail,
	s3AssetStore
};

export type WorkerServices = typeof defaultServices;

export type WorkerDeps = {
	db: Database;
	boss: Pick<PgBoss, 'send' | 'getJobById'>;
	// Absolute origin for links in emails.
	origin: string;
	services?: Partial<WorkerServices>;
};

export type AssistantReviewData = {
	userId: string;
	storyId?: string;
	universeId?: string;
	chapterId?: string;
	categories?: ReviewCategory[];
	mode?: 'full' | 'continuity';
};

export type AssistantSummariesData = { userId: string; storyId: string };

// The first distinct thing that went wrong in a run, for the notification
// title. The whole list rides on the job status the review modal polls.
function firstFailure(failures: ReviewFailure[] | undefined): string {
	return [...new Set((failures ?? []).map((failure) => failure.message))][0] ?? '';
}

// What a run that stopped early still left behind, for the notification that
// says it stopped.
function staged(notes: number): string {
	if (notes === 0) return '';
	return `, with ${notes} note${notes === 1 ? '' : 's'} left`;
}

export function createHandlers(deps: WorkerDeps) {
	const { db, boss, origin } = deps;
	const services: WorkerServices = { ...defaultServices, ...deps.services };

	// Queues each recipient's batched digest email after the shared delay.
	async function queueDigests(userIds: string[]) {
		for (const id of userIds) {
			await boss.send(
				NOTIFICATION_DIGEST_QUEUE,
				{ userId: id },
				{ startAfter: DIGEST_DELAY_SECONDS, singletonKey: id }
			);
		}
	}

	// Tells the writer how an Assistant run went, unless pg-boss is going to run
	// the job again (see job-guard.ts), so one run is one notice.
	async function notifyWriter(
		queue: string,
		job: Parameters<typeof shouldNotifyWriter>[2],
		userId: string,
		kind: Parameters<typeof insertNotifications>[2],
		payload: Parameters<typeof insertNotifications>[3]
	): Promise<void> {
		if (!(await shouldNotifyWriter(boss, queue, job))) {
			logEvent('warn', 'assistant.notice_deferred', { queue, jobId: job.id });
			return;
		}
		await queueDigests(await insertNotifications(db, [userId], kind, payload));
	}

	return {
		async mentionsScene(jobs: Job<{ sceneId: string }>[]) {
			for (const job of jobs) {
				const result = await rebuildSceneMentions(db, job.data.sceneId);
				if (result.ok) {
					logEvent('info', 'mentions.scene', { sceneId: job.data.sceneId, count: result.count });
				} else {
					logEvent('warn', 'mentions.scene_skipped', {
						sceneId: job.data.sceneId,
						reason: result.reason
					});
				}
			}
		},

		async mentionsUniverse(jobs: Job<{ universeId: string }>[]) {
			for (const job of jobs) {
				const count = await rebuildUniverseMentions(db, job.data.universeId);
				logEvent('info', 'mentions.universe', { universeId: job.data.universeId, scenes: count });
			}
		},

		// Backstop for any rebuild job that was dropped (a failed enqueue, or a
		// worker restart mid-job): re-index scenes whose mention watermark has
		// fallen behind.
		async reconcileMentions() {
			const reindexed = await reconcileMentions(db);
			if (reindexed > 0) logEvent('info', 'mentions.reconcile', { scenes: reindexed });
		},

		// Generates the stored export files (markdown zip, EPUB, PDF) for a freshly
		// published edition. Formats fail independently, so a PDF problem still
		// leaves the zip and EPUB downloadable.
		async exportArtifacts(jobs: Job<{ publicationId: string }>[]) {
			for (const job of jobs) {
				const result = await generateEditionArtifacts(db, job.data.publicationId);
				if (!result.ok) {
					logEvent('warn', 'exports.edition_skipped', {
						publicationId: job.data.publicationId,
						reason: result.reason
					});
					continue;
				}
				logEvent('info', 'exports.edition', {
					publicationId: job.data.publicationId,
					stored: result.stored
				});
				for (const failure of result.failed) {
					logEvent('error', 'exports.edition_failed', {
						publicationId: job.data.publicationId,
						format: failure.format,
						message: failure.error
					});
				}
			}
		},

		// Copies every stored asset and export file from the stashed previous
		// storage to the current one, after the admin re-points asset storage and
		// asks for the copy. Failures leave the stash in place for another run.
		async migrateAssets() {
			const source = await assetMigrationSource(db);
			const target = await effectiveAssetConfig(db);
			if (!source || !target) {
				logEvent('warn', 'assets.migration_skipped', { reason: 'no source or no storage' });
				return;
			}
			const result = await migrateAssetObjects(
				db,
				services.s3AssetStore(source),
				services.s3AssetStore(target)
			);
			await recordAssetMigrationResult(db, { finishedAt: new Date().toISOString(), ...result });
			if (result.failed === 0) await clearAssetMigrationSource(db);
			logEvent(result.failed > 0 ? 'warn' : 'info', 'assets.migration', {
				copied: result.copied,
				failed: result.failed
			});
		},

		// Builds a user-requested export (account, story, or universe archive, or a
		// story EPUB) off the web request path, stores it in the asset bucket, and
		// tells the owner it is ready to download. Old exports are swept after each
		// run.
		async userExport(jobs: Job<{ exportId: string }>[]) {
			for (const job of jobs) {
				const config = await effectiveAssetConfig(db);
				const store = config ? services.s3AssetStore(config) : null;
				const result = await runUserExport(db, job.data.exportId, store);
				if (!result.ok) {
					logEvent('warn', 'export.failed', { exportId: job.data.exportId, reason: result.reason });
					continue;
				}
				if (store) await pruneOwnerExports(db, store, result.ownerId);
				const digestUsers = await insertNotifications(db, [result.ownerId], 'export_ready', {
					title: 'Your export is ready to download.',
					href: `/exports/${job.data.exportId}`
				});
				await queueDigests(digestUsers);
				logEvent('info', 'export.ready', { exportId: job.data.exportId });
			}
		},

		// Whole-story or single-chapter Assistant review: fan over the scenes in
		// scope, stage the Assistant's notes through the review tools, then tell
		// the owner it is ready (or that the endpoint could not be reached).
		// Matches the inline single-scene endpoint, just unattended and over many
		// scenes.
		async assistantReview(jobs: JobWithMetadata<AssistantReviewData>[]) {
			for (const job of jobs) {
				const { userId, storyId, universeId, chapterId, categories, mode } = job.data;

				// A universe-wide continuity pass: no single story owns it. The notes
				// land on each owning story's scene; the writer is pointed at the
				// universe Plan page to follow them.
				if (mode === 'continuity' && universeId) {
					const [universe] = await db
						.select({
							ownerId: schema.universes.ownerId,
							name: schema.universes.name,
							slug: schema.universes.slug
						})
						.from(schema.universes)
						.where(eq(schema.universes.id, universeId));
					if (!universe || universe.ownerId !== userId) {
						logEvent('warn', 'assistant.continuity_skipped', {
							universeId,
							userId,
							reason: 'not owner'
						});
						continue;
					}
					const href = `/universes/${universe.slug}/plan`;
					let title: string;
					try {
						const result = await services.reviewUniverseContinuity(db, {
							userId,
							universeId,
							jobId: job.id,
							signal: job.signal
						});
						if (!result.ran) {
							title = `There was nothing to compare for continuity in "${universe.name}".`;
						} else if (result.notes === 0) {
							title = `The Assistant found no continuity issues across "${universe.name}".`;
						} else {
							title = `The Assistant left ${result.notes} continuity note${result.notes === 1 ? '' : 's'} across "${universe.name}".`;
						}
						if (result.capped) {
							title = `The continuity pass on "${universe.name}" stopped at about $${(result.spentUsd ?? 0).toFixed(2)}${staged(result.notes)}. Raise the cap in settings or run the review again to continue.`;
						}
						const problem = firstFailure(result.failures);
						if (problem) title += ` ${problem}`;
					} catch (err) {
						title = `The Assistant could not run the continuity pass on "${universe.name}": ${failureMessage(err)}`;
					}
					await notifyWriter(ASSISTANT_REVIEW_QUEUE, job, userId, 'assistant_review', {
						title,
						href
					});
					logEvent('info', 'assistant.continuity', { universeId });
					continue;
				}

				if (!storyId) {
					logEvent('warn', 'assistant.review_skipped', { userId, reason: 'no scope' });
					continue;
				}
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
					logEvent('warn', 'assistant.review_skipped', { storyId, userId, reason: 'not owner' });
					continue;
				}
				const href = `/stories/${story.slug}/review`;

				// A standalone story continuity pass: the consistency run alone, with
				// no per-scene copyedit passes before it.
				if (mode === 'continuity') {
					let title: string;
					try {
						const result = await services.reviewStoryContinuity(db, {
							userId,
							storyId,
							jobId: job.id,
							signal: job.signal
						});
						// The capped wording replaces the outcome line, so it is built
						// before the suffixes rather than over the top of them.
						if (result.capped) {
							title = `The continuity pass on "${story.title}" stopped at about $${(result.spentUsd ?? 0).toFixed(2)}${staged(result.notes)}. Raise the cap in settings or run the review again to continue.`;
						} else if (!result.ran) {
							title = `"${story.title}" needs at least two scenes for a continuity pass.`;
						} else if (result.notes === 0) {
							title = `The Assistant found no continuity issues in "${story.title}".`;
						} else {
							title = `The Assistant left ${result.notes} continuity note${result.notes === 1 ? '' : 's'} on "${story.title}".`;
						}
						if (result.summariesRefreshed) title += ' Summaries were refreshed first.';
						const problem = firstFailure(result.failures);
						if (problem) title += ` ${problem}`;
					} catch (err) {
						title = `The Assistant could not run the continuity pass on "${story.title}": ${failureMessage(err)}`;
					}
					await notifyWriter(ASSISTANT_REVIEW_QUEUE, job, userId, 'assistant_review', {
						title,
						href
					});
					logEvent('info', 'assistant.continuity', { storyId });
					continue;
				}

				// Like both continuity branches: an error that escapes the review must
				// still reach the writer, or the job fails with nothing said.
				let title: string;
				let done: Record<string, number | boolean>;
				try {
					const result = await services.reviewStoryScenes(db, {
						userId,
						storyId,
						chapterId,
						categories,
						jobId: job.id,
						signal: job.signal
					});
					const problem = firstFailure(result.failures);
					if (result.capped) {
						title = `The review of "${story.title}" stopped after ${result.reviewed} of ${result.total} scenes at about $${(result.spentUsd ?? 0).toFixed(2)}. Raise the cap in settings or run the review again to continue.`;
					} else if (result.aborted) {
						title = `The review of "${story.title}" was stopped before it finished.`;
					} else if (result.reviewed === 0 && result.failed > 0) {
						title = `The Assistant could not review "${story.title}": ${problem}`;
					} else if (result.notes === 0) {
						title = `The Assistant reviewed "${story.title}" and had no notes to add.`;
					} else {
						title = `The Assistant left ${result.notes} note${result.notes === 1 ? '' : 's'} on "${story.title}".`;
					}
					if (result.summariesRefreshed) title += ' Summaries were refreshed first.';
					if (result.failed > 0 && result.reviewed > 0) {
						title += ` ${result.failed} scene${result.failed === 1 ? '' : 's'} failed: ${problem}`;
					} else if (result.failed === 0 && problem) {
						title += ` ${problem}`;
					}
					done = { reviewed: result.reviewed, failed: result.failed, notes: result.notes };
				} catch (err) {
					title = `The Assistant could not review "${story.title}": ${failureMessage(err)}`;
					done = { threw: true };
				}
				await notifyWriter(ASSISTANT_REVIEW_QUEUE, job, userId, 'assistant_review', {
					title,
					href
				});
				logEvent('info', 'assistant.review', { storyId, ...done });
			}
		},

		// Whole-story summary maintenance: draft and refresh scene and chapter
		// summaries (the metadata that feeds recap and context). Owner re-checked
		// at run time; the writer is notified when it is done. Like the review
		// job, the gateway is called directly with no HTTP hop.
		async assistantSummaries(jobs: JobWithMetadata<AssistantSummariesData>[]) {
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
					logEvent('warn', 'assistant.summaries_skipped', { storyId, userId, reason: 'not owner' });
					continue;
				}
				const result = await services.summariseStory(db, { userId, storyId, signal: job.signal });
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
				if (result.capped) {
					title = `The Assistant stopped summarising "${story.title}" at about $${(result.spentUsd ?? 0).toFixed(2)}, after ${written} ${written === 1 ? 'summary' : 'summaries'}. Raise the cap in settings or run it again to continue.`;
				}
				if (result.capNotApplied) title += ` ${result.capNotApplied}`;
				await notifyWriter(ASSISTANT_SUMMARIES_QUEUE, job, userId, 'assistant_summaries', {
					title,
					href
				});
				logEvent('info', 'assistant.summaries', {
					storyId,
					scenes: result.scenes,
					chapters: result.chapters,
					failed: result.failed
				});
			}
		},

		async backup(jobs: Job<{ trigger?: 'scheduled' | 'manual' }>[]) {
			for (const job of jobs) {
				const result = await runBackup(db, job.data.trigger ?? 'scheduled');
				if (!result.ok) logEvent('error', 'backup.failed', { reason: result.reason });
				else if (result.skipped) logEvent('info', 'backup.skipped', { reason: 'unchanged' });
				else logEvent('info', 'backup.uploaded', { key: result.key });
			}
		},

		async email(jobs: Job<EmailJob>[]) {
			for (const job of jobs) {
				const resolved = await resolveEmailJob(db, job.data);
				if ('skipped' in resolved) {
					// A superseded link is routine; one that expired before it could be
					// sent means the person never got a working link, so it is a warning.
					logEvent(resolved.skipped === 'expired' ? 'warn' : 'info', 'email.skipped', {
						to: redactEmail(job.data.to),
						reason: resolved.skipped
					});
					continue;
				}
				await services.sendEmail(db, resolved.message);
				// Structured, with the recipient masked and the subject (which embeds
				// story titles) omitted, so account PII does not sit in the logs.
				logEvent('info', 'email.sent', { to: redactEmail(job.data.to) });
			}
		},

		// Transactional email that exhausted its retries (a prolonged SMTP
		// outage). The send is given up, but it must not vanish: log it loudly so
		// an operator knows. A link email holds no usable link to resend; the
		// person requests a new one (sign up again, forgot password, or retry the
		// change). The recipient flow already said "check your email", so there is
		// no other signal otherwise. The token id is safe to log: it is not a
		// credential.
		async emailDeadLetter(jobs: Job<EmailJob>[]) {
			for (const job of jobs) {
				logEvent('error', 'email.dropped', {
					to: redactEmail(job.data.to),
					...('tokenId' in job.data ? { tokenId: job.data.tokenId } : {})
				});
			}
		},

		// Notification digests: one email per recipient gathering everything that
		// arrived since the last one.
		async notificationDigest(jobs: Job<{ userId: string }>[]) {
			for (const job of jobs) {
				const digest = await buildUserDigest(db, job.data.userId, origin);
				if (!digest) continue;
				// Mark the rows emailed before sending: a job retry after a crash then
				// finds nothing to send rather than mailing the digest twice. The cost
				// is that a hard send failure drops one digest, which the next
				// notification re-forms; an un-recallable duplicate is the worse
				// outcome.
				await markEmailed(db, digest.ids);
				await services.sendEmail(db, digest.email);
				logEvent('info', 'notify.digest', { userId: job.data.userId, count: digest.ids.length });
			}
		},

		async reviewerDigest(jobs: Job<{ reviewerId: string }>[]) {
			for (const job of jobs) {
				const digest = await buildReviewerDigest(db, job.data.reviewerId, origin);
				if (!digest) continue;
				// Advance the watermark before sending, for the same reason as the
				// user digest above: a retry must not re-send, even at the cost of
				// dropping a digest on a hard send failure.
				await markReviewerNotified(db, digest.reviewerId, digest.upTo);
				await services.sendEmail(db, digest.email);
				logEvent('info', 'notify.reviewer_digest', { reviewerId: job.data.reviewerId });
			}
		},

		async purgeAccounts() {
			const due = await listAccountsDueForPurge(db);
			if (due.length === 0) return;
			const config = await effectiveAssetConfig(db);
			const store = config ? services.s3AssetStore(config) : null;
			for (const userId of due) {
				try {
					await purgeAccount(db, userId, store, { requireSchedule: true });
					logEvent('info', 'purge.account', { userId });
				} catch (error) {
					logEvent('error', 'purge.account_failed', { userId, ...errorFields(error) });
				}
			}
		},

		// Trashed universes and stories past their restore window go for good.
		// Universes first: their purge takes every story inside, trashed or not.
		async purgeUniverses() {
			for (const universeId of await listUniversesDueForPurge(db)) {
				try {
					await purgeUniverse(db, universeId);
					logEvent('info', 'purge.universe', { universeId });
				} catch (error) {
					logEvent('error', 'purge.universe_failed', { universeId, ...errorFields(error) });
				}
			}
			for (const storyId of await listStoriesDueForPurge(db)) {
				try {
					await purgeStory(db, storyId);
					logEvent('info', 'purge.story', { storyId });
				} catch (error) {
					logEvent('error', 'purge.story_failed', { storyId, ...errorFields(error) });
				}
			}
		},

		// Bucket objects of deleted rows, once no kept backup can still point at
		// them.
		async sweepDeletedObjects() {
			const config = await effectiveAssetConfig(db);
			if (!config) return;
			const graceDays = objectDeletionGraceDays(await effectiveBackupConfig(db));
			const result = await sweepDeletedObjects(db, services.s3AssetStore(config), graceDays);
			if (result.removed + result.kept + result.failed > 0) {
				logEvent(result.failed > 0 ? 'warn' : 'info', 'assets.sweep', {
					removed: result.removed,
					kept: result.kept,
					failed: result.failed
				});
			}
		},

		// The recorded progress of a review is disposable: it serves the status
		// endpoint while a run is in flight and a resume shortly after, and
		// nothing is lost when it goes. Old rows are swept so the table does not
		// grow for good.
		async purgeReviewRuns() {
			const deleted = await purgeReviewRuns(db);
			if (deleted > 0) logEvent('info', 'purge.review_runs', { deleted });
		},

		async purgeSessions() {
			const deleted = await purgeSessions(db);
			if (deleted > 0) logEvent('info', 'purge.sessions', { deleted });
		}
	};
}
