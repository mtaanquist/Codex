import type { Job, JobWithMetadata, PgBoss } from 'pg-boss';
import { and, eq, isNull } from 'drizzle-orm';
import {
	ASSISTANT_DRAFT_QUEUE,
	ASSISTANT_ENRICH_QUEUE,
	DIGEST_DELAY_SECONDS,
	LEGACY_ASSISTANT_REVIEW_QUEUE,
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
import { parseCategories, type PatternScope, type ReviewCategory } from '../lib/review-shape.ts';
import { summariseStory } from '../lib/server/llm/summaries.ts';
import {
	enrichEntityFromText,
	enrichUniverse,
	MAX_FAILURES_IN_A_ROW
} from '../lib/server/llm/enrich.ts';
import {
	AssistantDisabledError,
	NoModelError,
	ReplyCutOffError,
	ReplyRefusedError
} from '../lib/server/llm/gateway.ts';
import { EndpointReplyError } from '../lib/server/llm/providers/types.ts';
import { summariseCharacterArc } from '../lib/server/llm/arc-summary.ts';
import {
	failChapterDraft,
	failSceneDraft,
	runChapterDraft,
	runSceneDraft
} from '../lib/server/llm/scene-draft.ts';
import { chapterDraftHref, sceneDraftHref } from '../lib/scene-draft.ts';
import { purgeJobSpend } from '../lib/server/llm/job-spend.ts';
import { purgeReviewRuns, ReviewRunLoadError } from '../lib/server/review-runs.ts';
import { purgeSessions } from '../lib/server/auth.ts';
import { purgeExternalAccess } from '../lib/server/mcp/oauth.ts';
import { insertNotifications } from '../lib/server/notify-core.ts';
import { storyIsLive } from '../lib/server/universe-scope.ts';
import { shouldNotifyWriter, withJobRunSignal } from './job-guard.ts';
import { spentPhrase } from '../lib/format.ts';

// The job handlers, kept apart from index.ts (which owns the pg-boss
// connection, queue setup and schedules) so tests can run them directly.

// The calls that reach outside the database (the Assistant endpoint, SMTP,
// the bucket). Tests swap them; the worker uses the real ones.
const defaultServices = {
	reviewStoryScenes,
	reviewStoryContinuity,
	reviewUniverseContinuity,
	summariseStory,
	enrichUniverse,
	enrichEntityFromText,
	summariseCharacterArc,
	runSceneDraft,
	runChapterDraft,
	sendEmail,
	s3AssetStore
};

export type WorkerServices = typeof defaultServices;

export type WorkerDeps = {
	db: Database;
	boss: Pick<PgBoss, 'send' | 'getJobById' | 'complete'>;
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
	patterns?: PatternScope;
};

export type AssistantSummariesData = { userId: string; storyId: string };

// characterId set: rewrite that character's arc instead of the enrichment pass.
// read set: a full-text read of one entity (the "Suggest details" button),
// from the story it names or else across the universe.
export type AssistantEnrichData = {
	userId: string;
	universeId: string;
	characterId?: string;
	read?: { entityId: string; name: string; storyId?: string; mode: 'scenes' | 'book' };
};

// One scene draft: the staged row (assistant_drafts) the job writes.
export type AssistantDraftData = {
	userId: string;
	storyId: string;
	sceneId: string;
	draftId: string;
};

// A chapter drafted scene by scene: the staged rows the job writes, in order,
// and what the writer said about the chapter as a whole.
export type AssistantChapterDraftData = {
	userId: string;
	storyId: string;
	chapterId: string;
	draftIds: string[];
	brief: string;
};

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

// The arc button reads Write arc or Refresh arc, so the notices name neither.
const ARC_AGAIN = "try again from the character's entry in Plan";
const PICK_MODEL = 'Pick one under Account, Assistant, Models per role';
const DETAILS_AGAIN = 'select "Suggest details with the Assistant" on the entry again';
const DRAFT_AGAIN = 'type /draft in the Assistant chat to ask again';
const CHAPTER_DRAFT_AGAIN = 'type /draft-chapter in the Assistant chat to ask again';
const KEEP_OR_DISCARD = 'Open each scene to keep or discard its draft.';

// "1 scene", "3 scenes".
function sceneCount(n: number): string {
	return `${n} ${n === 1 ? 'scene' : 'scenes'}`;
}

// "1 entry", "3 other entries", for an enrich notice.
function entries(n: number, other = false): string {
	return `${n} ${other ? 'other ' : ''}${n === 1 ? 'entry' : 'entries'}`;
}

// LEGACY (#1041): what a review queued before the upgrade checked, read from
// its job, for continuing a run it capped (see adoptCappedRun). Null when
// pg-boss no longer has the job, or it does not say.
export async function legacyJobCategories(
	boss: Pick<PgBoss, 'getJobById'>,
	jobId: string
): Promise<ReviewCategory[] | null> {
	const found = await boss.getJobById(LEGACY_ASSISTANT_REVIEW_QUEUE, jobId);
	const categories = (found?.data as { categories?: unknown } | undefined)?.categories;
	return Array.isArray(categories) ? parseCategories(categories) : null;
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

	// A review that could not read its earlier progress fails the attempt, so
	// pg-boss runs it again rather than the review starting over (#1113). The
	// last attempt reports it like any other error.
	function retryLoadFailure(err: unknown, job: JobWithMetadata<AssistantReviewData>): void {
		if (
			err instanceof ReviewRunLoadError &&
			!job.signal?.aborted &&
			job.retryCount < job.retryLimit
		) {
			throw err;
		}
	}

	// One character's arc, from an assistant-enrich job that names it.
	async function characterArc(job: JobWithMetadata<AssistantEnrichData>, characterId: string) {
		const { userId, universeId } = job.data;
		const [character] = await db
			.select({ name: schema.characters.name })
			.from(schema.characters)
			.where(and(eq(schema.characters.id, characterId), eq(schema.characters.ownerId, userId)));
		if (!character) {
			logEvent('warn', 'assistant.arc_skipped', { characterId, userId, reason: 'gone' });
			return;
		}
		const href = `/universes/${universeId}/plan?entity=${characterId}`;
		let title: string;
		try {
			const result = await withJobRunSignal(boss, job, (signal) =>
				services.summariseCharacterArc(db, {
					userId,
					characterId,
					jobId: job.id,
					signal
				})
			);
			if (result.outcome === 'missing') {
				logEvent('warn', 'assistant.arc_skipped', { characterId, userId, reason: 'not owner' });
				return;
			}
			title =
				result.outcome === 'capped'
					? `The Assistant did not write the arc for ${character.name}: this job reached the spend cap at ${spentPhrase(result.spentUsd ?? 0)}. Raise the cap in settings, then ${ARC_AGAIN}.`
					: result.outcome === 'empty'
						? `The Assistant found no scenes that mention ${character.name}, so there is no arc to write yet.`
						: `The Assistant wrote the arc for ${character.name}.`;
		} catch (error) {
			logEvent('error', 'assistant.arc_failed', { characterId, ...errorFields(error) });
			if (
				error instanceof ReplyCutOffError ||
				error instanceof ReplyRefusedError ||
				error instanceof EndpointReplyError
			) {
				// A retry would stop at the same limit, be declined again (and billed
				// again), or get the same answer back, so say why and end here. The
				// job is settled as completed with a failed output, which the
				// activity card reads as failed, and pg-boss does not run it again.
				await boss.complete(ASSISTANT_ENRICH_QUEUE, job, { failed: true });
				await queueDigests(
					await insertNotifications(db, [userId], 'assistant_enrich', {
						title:
							error instanceof ReplyCutOffError
								? `The Assistant could not write the arc for ${character.name}. ${error.message}`
								: error instanceof ReplyRefusedError
									? `The model declined to write the arc for ${character.name}, so nothing was saved.`
									: `The Assistant could not write the arc for ${character.name}: the endpoint did not send a reply. Check the endpoint in your settings, then ${ARC_AGAIN}.`,
						href
					})
				);
				return;
			}
			if (error instanceof AssistantDisabledError) {
				// A retry would be refused the same way, so end here, settled as
				// failed like a cut-off.
				await boss.complete(ASSISTANT_ENRICH_QUEUE, job, { failed: true });
				await queueDigests(
					await insertNotifications(db, [userId], 'assistant_enrich', {
						title:
							error instanceof NoModelError
								? `No model is chosen for the Assistant, so it did not write the arc for ${character.name}. ${PICK_MODEL}, then ${ARC_AGAIN}.`
								: `The Assistant is turned off, so it did not write the arc for ${character.name}. Switch it back on in your settings, then ${ARC_AGAIN}.`,
						href
					})
				);
				return;
			}
			if (!job.signal?.aborted && job.retryCount < job.retryLimit) {
				// pg-boss runs it again, and a retry usually writes the arc (a
				// passing endpoint fault has cleared), so say nothing until the last
				// attempt. notifyWriter would not hold
				// this back: a thrown job is still active when it runs.
				throw error;
			}
			if (job.signal?.aborted) {
				title = `Writing the arc for ${character.name} was stopped before it finished.`;
			} else {
				title = `The Assistant could not write the arc for ${character.name}. Check the endpoint in your settings.`;
			}
			// notifyWriter holds the notice back only when pg-boss has already
			// queued the retry (an expiry or abort). The job is failed either
			// way, so the activity card shows it did not work.
			await notifyWriter(ASSISTANT_ENRICH_QUEUE, job, userId, 'assistant_enrich', { title, href });
			throw error;
		}
		await notifyWriter(ASSISTANT_ENRICH_QUEUE, job, userId, 'assistant_enrich', { title, href });
		logEvent('info', 'assistant.arc', { characterId });
	}

	// A full-text read of one entity for details, from an assistant-enrich job
	// that names it. What each part finds is staged as it is read, so every
	// notice says what was left behind.
	async function entityDetails(
		job: JobWithMetadata<AssistantEnrichData>,
		read: NonNullable<AssistantEnrichData['read']>
	) {
		const { userId, universeId } = job.data;
		const { entityId, name } = read;
		const scope = read.storyId ? { storyId: read.storyId } : { universeId };
		const href = read.storyId
			? `/stories/${read.storyId}/plan?entity=${entityId}`
			: `/universes/${universeId}/plan?entity=${entityId}`;
		const count = (n: number) => `${n} ${n === 1 ? 'suggestion' : 'suggestions'}`;
		let title: string;
		try {
			const result = await withJobRunSignal(boss, job, (signal) =>
				services.enrichEntityFromText(db, {
					userId,
					scope,
					entityId,
					mode: read.mode,
					jobId: job.id,
					signal
				})
			);
			if (result.missing) {
				logEvent('warn', 'assistant.details_skipped', { entityId, userId });
				return;
			}
			const staged = result.suggestions.length;
			const left = staged > 0 ? `, with ${count(staged)} left on the entry` : '';
			if (result.capped) {
				title = `The Assistant stopped reading for details about ${name} at ${spentPhrase(result.spentUsd ?? 0)}${left}. Raise the cap in settings, then ${DETAILS_AGAIN}.`;
			} else if (result.partial) {
				title = `The Assistant stopped partway through reading for details about ${name}${left}. ${result.partialNote ?? `To read the rest, ${DETAILS_AGAIN}.`}`;
			} else if (result.scenes === 0) {
				title = `The Assistant found no scenes that mention ${name}, so there was nothing to read.`;
			} else if (staged === 0) {
				title = `The Assistant read ${result.scenes} ${result.scenes === 1 ? 'scene' : 'scenes'} and found nothing new to suggest for ${name}.`;
			} else {
				title = `The Assistant left ${count(staged)} for ${name}. Open the entry to accept or reject them.`;
			}
			logEvent('info', 'assistant.details', {
				entityId,
				scenes: result.scenes,
				requests: result.requests,
				staged,
				...(result.partial ? { partial: true } : {}),
				...(result.capped ? { capped: true } : {})
			});
		} catch (error) {
			// Thrown only when nothing was found before the failure.
			logEvent('error', 'assistant.details_failed', { entityId, ...errorFields(error) });
			const settled =
				error instanceof ReplyCutOffError ||
				error instanceof ReplyRefusedError ||
				error instanceof EndpointReplyError ||
				error instanceof AssistantDisabledError;
			if (settled) {
				// A retry would end the same way, so say why and end here, settled
				// as completed with a failed output like an arc.
				await boss.complete(ASSISTANT_ENRICH_QUEUE, job, { failed: true });
				await queueDigests(
					await insertNotifications(db, [userId], 'assistant_enrich', {
						title:
							error instanceof ReplyCutOffError
								? `The Assistant could not read for details about ${name}. ${error.message}`
								: error instanceof ReplyRefusedError
									? `The model declined to read for details about ${name}, so nothing was suggested.`
									: error instanceof EndpointReplyError
										? `The Assistant could not read for details about ${name}: the endpoint did not send a reply. Check the endpoint in your settings, then ${DETAILS_AGAIN}.`
										: error instanceof NoModelError
											? `No model is chosen for the Assistant, so it did not read for details about ${name}. ${PICK_MODEL}, then ${DETAILS_AGAIN}.`
											: `The Assistant is turned off, so it did not read for details about ${name}. Switch it back on in your settings, then ${DETAILS_AGAIN}.`,
						href
					})
				);
				return;
			}
			// Nothing was found, so a retry repeats no kept work. Say nothing
			// until the last attempt.
			if (!job.signal?.aborted && job.retryCount < job.retryLimit) throw error;
			title = job.signal?.aborted
				? `Reading for details about ${name} was stopped before anything was found.`
				: `The Assistant could not read for details about ${name}. Check the endpoint in your settings.`;
			await notifyWriter(ASSISTANT_ENRICH_QUEUE, job, userId, 'assistant_enrich', { title, href });
			throw error;
		}
		await notifyWriter(ASSISTANT_ENRICH_QUEUE, job, userId, 'assistant_enrich', { title, href });
	}

	// One scene draft. The job writes only its staged row; the notice sends the
	// writer to the scene, where the Assistant panel shows the draft to keep or
	// discard.
	async function sceneDraft(job: JobWithMetadata<AssistantDraftData>) {
		const { userId, storyId, sceneId, draftId } = job.data;
		const href = sceneDraftHref(storyId, sceneId);
		const [scene] = await db
			.select({ title: schema.scenes.title })
			.from(schema.scenes)
			.innerJoin(schema.stories, eq(schema.scenes.storyId, schema.stories.id))
			.where(and(eq(schema.scenes.id, sceneId), eq(schema.stories.ownerId, userId)));
		const name = scene?.title ? `the scene "${scene.title}"` : 'your scene';
		// Settled as completed with a failed output, which the activity card
		// reads as failed, and pg-boss does not run it again.
		const settleFailed = () => boss.complete(ASSISTANT_DRAFT_QUEUE, job, { failed: true });
		let title: string;
		try {
			const result = await withJobRunSignal(boss, job, (signal) =>
				services.runSceneDraft(db, { userId, draftId, jobId: job.id, signal })
			);
			if (result.outcome === 'missing') {
				logEvent('warn', 'assistant.draft_skipped', { draftId, userId });
				return;
			}
			if (result.outcome === 'stopped') {
				title = `The draft of ${name} was stopped before it finished, so nothing was kept.`;
			} else if (result.outcome === 'empty') {
				await settleFailed();
				title = `The Assistant did not draft ${name}. ${result.note}`;
			} else if (result.outcome === 'off') {
				await settleFailed();
				title = `The Assistant is off for this story, so it did not draft ${name}.`;
			} else if (result.outcome === 'capped') {
				await settleFailed();
				title = `The Assistant did not draft ${name}. ${result.note} Then ${DRAFT_AGAIN}.`;
			} else {
				title = `The Assistant drafted ${name} (${result.words} ${result.words === 1 ? 'word' : 'words'}). Open the scene to keep or discard the draft.`;
				if (result.cutOff) title += ' It stopped at the length limit, so it may end mid-scene.';
				if (result.capNotApplied) title += ` ${result.capNotApplied}`;
			}
			logEvent('info', 'assistant.draft', { draftId, outcome: result.outcome });
		} catch (error) {
			logEvent('error', 'assistant.draft_failed', { draftId, ...errorFields(error) });
			const settled =
				error instanceof ReplyRefusedError ||
				error instanceof EndpointReplyError ||
				error instanceof AssistantDisabledError;
			if (settled) {
				// A retry would end the same way, so say why and end here.
				const why =
					error instanceof ReplyRefusedError
						? 'The model declined to write this draft.'
						: error instanceof EndpointReplyError
							? `The endpoint did not send a reply. Check the endpoint in your settings, then ${DRAFT_AGAIN}.`
							: error instanceof NoModelError
								? `No model is chosen for the Assistant. ${PICK_MODEL}, then ${DRAFT_AGAIN}.`
								: `The Assistant is turned off. Switch it back on in your settings, then ${DRAFT_AGAIN}.`;
				await failSceneDraft(db, draftId, why);
				await settleFailed();
				await queueDigests(
					await insertNotifications(db, [userId], 'assistant_draft', {
						title: `The Assistant did not draft ${name}. ${why}`,
						href
					})
				);
				return;
			}
			// pg-boss runs it again (a passing endpoint fault, an expiry, a worker
			// shutting down), and the draft stays unsettled for that attempt.
			if (job.retryCount < job.retryLimit) throw error;
			await failSceneDraft(
				db,
				draftId,
				`The Assistant could not write this draft. Check the endpoint in your settings, then ${DRAFT_AGAIN}.`
			);
			await notifyWriter(ASSISTANT_DRAFT_QUEUE, job, userId, 'assistant_draft', {
				title: `The Assistant could not draft ${name}. Check the endpoint in your settings.`,
				href
			});
			throw error;
		}
		await notifyWriter(ASSISTANT_DRAFT_QUEUE, job, userId, 'assistant_draft', { title, href });
	}

	// A chapter drafted scene by scene. The job writes only the staged rows;
	// the notice says how many scenes were drafted and, when the run ended
	// early, why.
	async function chapterDraft(job: JobWithMetadata<AssistantChapterDraftData>) {
		const { userId, storyId, chapterId, draftIds, brief } = job.data;
		const [chapter] = await db
			.select({ title: schema.chapters.title })
			.from(schema.chapters)
			.innerJoin(schema.stories, eq(schema.chapters.storyId, schema.stories.id))
			.where(and(eq(schema.chapters.id, chapterId), eq(schema.stories.ownerId, userId)));
		const name = chapter?.title ? `the chapter "${chapter.title}"` : 'your chapter';
		// A chapter deleted meanwhile leaves its scenes, and their drafts, in the
		// story.
		const href = chapter ? chapterDraftHref(storyId, chapterId) : `/stories/${storyId}`;
		const settleFailed = () => boss.complete(ASSISTANT_DRAFT_QUEUE, job, { failed: true });
		// What a run that ended on a fault leaves, for its notice.
		const kept = (drafted: number) =>
			drafted > 0
				? ` ${sceneCount(drafted)} ${drafted === 1 ? 'was' : 'were'} drafted before that. ${KEEP_OR_DISCARD}`
				: '';
		let title: string;
		try {
			const result = await withJobRunSignal(boss, job, (signal) =>
				services.runChapterDraft(db, { userId, storyId, brief, draftIds, jobId: job.id, signal })
			);
			if (result.outcome === 'missing') {
				logEvent('warn', 'assistant.chapter_draft_skipped', { chapterId, userId });
				return;
			}
			const { drafted, total, ended } = result;
			if (!ended) {
				title =
					drafted === 0
						? `The Assistant drafted no scenes in ${name}.`
						: drafted === total
							? `The Assistant drafted ${sceneCount(drafted)} in ${name}. ${KEEP_OR_DISCARD}`
							: `The Assistant drafted ${drafted} of ${sceneCount(total)} in ${name}. ${KEEP_OR_DISCARD}`;
			} else {
				const why =
					ended === 'stopped'
						? 'You stopped it'
						: ended === 'off'
							? 'The Assistant is off for this story now'
							: ended === 'empty'
								? 'A scene came back with no text'
								: 'The next scene could have taken it past your spend cap';
				title =
					drafted === 0
						? `The Assistant drafted no scenes in ${name}. ${why}, so nothing was kept.`
						: `The Assistant drafted ${drafted} of ${sceneCount(total)} in ${name}. ${why}, so the rest were not drafted. ${KEEP_OR_DISCARD}`;
				if (ended === 'empty' && result.emptyNote) title += ` ${result.emptyNote}`;
				if (ended === 'capped') {
					title += ` ${result.cappedNote} Then ${CHAPTER_DRAFT_AGAIN}.`;
				}
				// Nothing to show for it: the activity card says so too.
				if (drafted === 0 && ended !== 'stopped') await settleFailed();
			}
			if (result.gone > 0) {
				title += ` ${sceneCount(result.gone)} ${result.gone === 1 ? 'was' : 'were'} no longer there.`;
			}
			if (result.cutOff > 0) {
				title += ` ${sceneCount(result.cutOff)} stopped at the length limit, so ${result.cutOff === 1 ? 'it' : 'they'} may end early.`;
			}
			if (result.capNotApplied) title += ` ${result.capNotApplied}`;
			logEvent('info', 'assistant.chapter_draft', { chapterId, drafted, total, ended });
		} catch (error) {
			logEvent('error', 'assistant.chapter_draft_failed', { chapterId, ...errorFields(error) });
			const settled =
				error instanceof ReplyRefusedError ||
				error instanceof EndpointReplyError ||
				error instanceof AssistantDisabledError;
			if (settled) {
				// A retry would end the same way, so say why and end here.
				const why =
					error instanceof ReplyRefusedError
						? 'The model declined to write a scene.'
						: error instanceof EndpointReplyError
							? `The endpoint did not send a reply. Check the endpoint in your settings, then ${CHAPTER_DRAFT_AGAIN}.`
							: error instanceof NoModelError
								? `No model is chosen for the Assistant. ${PICK_MODEL}, then ${CHAPTER_DRAFT_AGAIN}.`
								: `The Assistant is turned off. Switch it back on in your settings, then ${CHAPTER_DRAFT_AGAIN}.`;
				const left = await failChapterDraft(db, userId, draftIds, why);
				await settleFailed();
				await queueDigests(
					await insertNotifications(db, [userId], 'assistant_draft', {
						title: `The Assistant did not finish drafting ${name}. ${why}${kept(left.drafted)}`,
						href
					})
				);
				return;
			}
			// pg-boss runs it again, and the retry carries on from the scene that
			// failed: the scenes already drafted are kept.
			if (job.retryCount < job.retryLimit) throw error;
			const left = await failChapterDraft(
				db,
				userId,
				draftIds,
				`The Assistant could not write this draft. Check the endpoint in your settings, then ${DRAFT_AGAIN}.`
			);
			await notifyWriter(ASSISTANT_DRAFT_QUEUE, job, userId, 'assistant_draft', {
				title: `The Assistant could not finish drafting ${name}. Check the endpoint in your settings.${kept(left.drafted)}`,
				href
			});
			throw error;
		}
		await notifyWriter(ASSISTANT_DRAFT_QUEUE, job, userId, 'assistant_draft', { title, href });
	}

	return {
		// One scene drafted from the writer's brief, or a chapter's scenes drafted
		// one by one, staged for the writer to keep or discard. Only ever queued
		// by the writer's own request.
		async assistantDraft(jobs: JobWithMetadata<AssistantDraftData | AssistantChapterDraftData>[]) {
			for (const job of jobs) {
				if ('draftIds' in job.data) {
					await chapterDraft(job as JobWithMetadata<AssistantChapterDraftData>);
				} else await sceneDraft(job as JobWithMetadata<AssistantDraftData>);
			}
		},

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
				const { userId, storyId, universeId, chapterId, categories, mode, patterns } = job.data;

				// A universe-wide continuity pass: no single story owns it. The notes
				// land on each owning story's scene; the writer is pointed at the
				// universe Plan page to follow them.
				if (mode === 'continuity' && universeId) {
					const [universe] = await db
						.select({
							ownerId: schema.universes.ownerId,
							name: schema.universes.name
						})
						.from(schema.universes)
						.where(and(eq(schema.universes.id, universeId), isNull(schema.universes.deletedAt)));
					if (!universe || universe.ownerId !== userId) {
						logEvent('warn', 'assistant.continuity_skipped', {
							universeId,
							userId,
							reason: universe ? 'not owner' : 'gone'
						});
						continue;
					}
					// Stored links use the id: a slug can pass to another row on a
					// rename or once this one is trashed.
					const href = `/universes/${universeId}/plan`;
					let title: string;
					try {
						const result = await withJobRunSignal(boss, job, (signal) =>
							services.reviewUniverseContinuity(db, {
								userId,
								universeId,
								jobId: job.id,
								signal
							})
						);
						if (!result.ran) {
							title = `There was nothing to compare for continuity in "${universe.name}".`;
						} else if (result.notes === 0) {
							title = `The Assistant found no continuity issues across "${universe.name}".`;
						} else {
							title = `The Assistant left ${result.notes} continuity note${result.notes === 1 ? '' : 's'} across "${universe.name}".`;
						}
						if (result.capped) {
							title = `The continuity pass on "${universe.name}" stopped at ${spentPhrase(result.spentUsd ?? 0, result.spentEstimated)}${staged(result.notes)}. Raise the cap in settings or run the review again to continue.`;
						}
						const problem = firstFailure(result.failures);
						if (problem) title += ` ${problem}`;
					} catch (err) {
						retryLoadFailure(err, job);
						title = `The Assistant could not run the continuity pass on "${universe.name}": ${failureMessage(err)}`;
					}
					await notifyWriter(job.name, job, userId, 'assistant_review', {
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
						title: schema.stories.title
					})
					.from(schema.stories)
					.where(and(eq(schema.stories.id, storyId), storyIsLive()));
				// Re-check ownership at run time: the story may have been deleted or
				// trashed since.
				if (!story || story.ownerId !== userId) {
					logEvent('warn', 'assistant.review_skipped', {
						storyId,
						userId,
						reason: story ? 'not owner' : 'gone'
					});
					continue;
				}
				const href = `/stories/${storyId}/review`;

				// A standalone story continuity pass: the consistency run alone, with
				// no per-scene copyedit passes before it.
				if (mode === 'continuity') {
					let title: string;
					try {
						const result = await withJobRunSignal(boss, job, (signal) =>
							services.reviewStoryContinuity(db, {
								userId,
								storyId,
								jobId: job.id,
								signal
							})
						);
						// The capped wording replaces the outcome line, so it is built
						// before the suffixes rather than over the top of them.
						if (result.capped) {
							title = `The continuity pass on "${story.title}" stopped at ${spentPhrase(result.spentUsd ?? 0, result.spentEstimated)}${staged(result.notes)}. Raise the cap in settings or run the review again to continue.`;
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
						retryLoadFailure(err, job);
						title = `The Assistant could not run the continuity pass on "${story.title}": ${failureMessage(err)}`;
					}
					await notifyWriter(job.name, job, userId, 'assistant_review', {
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
					const result = await withJobRunSignal(boss, job, (signal) =>
						services.reviewStoryScenes(db, {
							userId,
							storyId,
							chapterId,
							categories,
							patterns,
							jobId: job.id,
							signal,
							legacyJobCategories: (jobId) => legacyJobCategories(boss, jobId)
						})
					);
					const problem = firstFailure(result.failures);
					if (result.capped) {
						title = `The review of "${story.title}" stopped after ${result.reviewed} of ${result.total} scenes at ${spentPhrase(result.spentUsd ?? 0, result.spentEstimated)}. Raise the cap in settings or run the review again to continue.`;
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
					retryLoadFailure(err, job);
					title = `The Assistant could not review "${story.title}": ${failureMessage(err)}`;
					done = { threw: true };
				}
				await notifyWriter(job.name, job, userId, 'assistant_review', {
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
						title: schema.stories.title
					})
					.from(schema.stories)
					.where(and(eq(schema.stories.id, storyId), storyIsLive()));
				if (!story || story.ownerId !== userId) {
					logEvent('warn', 'assistant.summaries_skipped', {
						storyId,
						userId,
						reason: story ? 'not owner' : 'gone'
					});
					continue;
				}
				const result = await withJobRunSignal(boss, job, (signal) =>
					services.summariseStory(db, {
						userId,
						storyId,
						jobId: job.id,
						signal
					})
				);
				const written = result.scenes + result.chapters;
				const href = `/stories/${storyId}`;
				const after =
					written > 0 ? `, after ${written} ${written === 1 ? 'summary' : 'summaries'}` : '';
				let title: string;
				if (result.noModel) {
					title = `No model is chosen for the Assistant, so it stopped summarising "${story.title}"${after}. ${PICK_MODEL}, then run it again.`;
				} else if (result.disabled) {
					title = `The Assistant is turned off, so it stopped summarising "${story.title}"${after}. Switch it back on in your settings, then run it again.`;
				} else if (written === 0 && result.failed > 0) {
					title = `The Assistant could not summarise "${story.title}". Check the endpoint in your settings.`;
				} else if (written === 0 && result.changed) {
					title = `"${story.title}" changed while the Assistant was summarising it, so nothing was saved. Run it again to bring the summaries up to date.`;
				} else if (written === 0) {
					title = `The Assistant found nothing to summarise in "${story.title}".`;
				} else {
					title = `The Assistant updated ${written} ${written === 1 ? 'summary' : 'summaries'} in "${story.title}".`;
				}
				if (result.aborted) {
					title = `The Assistant stopped summarising "${story.title}" before it finished, after ${written} ${written === 1 ? 'summary' : 'summaries'}.`;
				}
				if (result.capped) {
					title = `The Assistant stopped summarising "${story.title}" at ${spentPhrase(result.spentUsd ?? 0, result.spentEstimated)}, after ${written} ${written === 1 ? 'summary' : 'summaries'}. Raise the cap in settings or run it again to continue.`;
				}
				if (result.capNotApplied) title += ` ${result.capNotApplied}`;
				await notifyWriter(job.name, job, userId, 'assistant_summaries', {
					title,
					href
				});
				logEvent('info', 'assistant.summaries', {
					storyId,
					scenes: result.scenes,
					chapters: result.chapters,
					failed: result.failed,
					...(result.changed ? { changed: result.changed } : {}),
					...(result.noModel ? { noModel: true } : {}),
					...(result.disabled ? { disabled: true } : {})
				});
				// Settled as failed, as an enrich pass that stops the same way is: a
				// retry would be refused again.
				if (result.noModel || result.disabled) {
					await boss.complete(job.name, job, { failed: true });
				}
			}
		},

		// The background enrichment pass over a universe's entities: stages alias,
		// detail, and summary suggestions for every entry with new prose to read.
		// A job naming a character rewrites that character's arc instead, and one
		// naming a read reads one entry's scenes in full. Owner
		// re-checked at run time; the writer is notified when it is done.
		async assistantEnrich(jobs: JobWithMetadata<AssistantEnrichData>[]) {
			for (const job of jobs) {
				if (job.data.characterId) {
					await characterArc(job, job.data.characterId);
					continue;
				}
				if (job.data.read) {
					await entityDetails(job, job.data.read);
					continue;
				}
				const { userId, universeId } = job.data;
				const [universe] = await db
					.select({
						ownerId: schema.universes.ownerId,
						name: schema.universes.name
					})
					.from(schema.universes)
					.where(and(eq(schema.universes.id, universeId), isNull(schema.universes.deletedAt)));
				if (!universe || universe.ownerId !== userId) {
					logEvent('warn', 'assistant.enrich_skipped', {
						universeId,
						userId,
						reason: universe ? 'not owner' : 'gone'
					});
					continue;
				}
				const result = await withJobRunSignal(boss, job, (signal) =>
					services.enrichUniverse(db, {
						userId,
						universeId,
						jobId: job.id,
						signal
					})
				);
				const href = `/universes/${universeId}/plan`;
				const name = universe.name;
				const suggestions = `${result.staged} ${result.staged === 1 ? 'suggestion' : 'suggestions'}`;
				// For a pass that stopped early: what it still left behind, if anything.
				const left = result.staged > 0 ? `, with ${suggestions} left` : '';
				const readNothing = result.entities === 0 && !result.unchanged && result.failed > 0;
				let title: string;
				if (result.noModel) {
					title = `No model is chosen for the Assistant, so it stopped reading the entries in "${name}"${left}. ${PICK_MODEL}, then type /enrich to carry on.`;
				} else if (result.disabled) {
					title = `The Assistant is turned off, so it stopped reading the entries in "${name}"${left}. Switch it back on in your settings, then type /enrich to carry on.`;
				} else if (result.stoppedFailing) {
					title = `The Assistant stopped reading the entries in "${name}" after ${MAX_FAILURES_IN_A_ROW} in a row could not be read${left}. Check the endpoint in your settings, then type /enrich to carry on.`;
				} else if (result.aborted) {
					title = `The Assistant stopped reading the entries in "${name}" before it finished${left}. Type /enrich to carry on.`;
				} else if (readNothing) {
					title = `The Assistant could not read the entries in "${name}". ${result.cutOff ?? 'Check the endpoint in your settings.'}`;
				} else if (result.staged === 0) {
					title = `The Assistant found nothing new to suggest for the entries in "${name}".`;
				} else {
					title = `The Assistant left ${suggestions} on the entries in "${name}". Open an entry in Plan to accept or reject them.`;
				}
				// The entries that failed in a pass that read or passed over others. A
				// pass stopped for failing already says why.
				if ((result.entities > 0 || !!result.unchanged) && !result.stoppedFailing) {
					const cutOffs = result.cutOffs ?? 0;
					const others = result.failed - cutOffs;
					if (cutOffs > 0) {
						title += ` ${entries(cutOffs)} could not be read: ${result.cutOff}`;
					}
					if (others > 0) {
						title += ` ${entries(others, cutOffs > 0)} could not be read. Check the endpoint in your settings.`;
					}
				}
				if (result.capped) {
					const spent = spentPhrase(result.spentUsd ?? 0, result.spentEstimated);
					title = `The Assistant stopped reading the entries in "${name}" at ${spent}${left}. Raise the cap in settings or run it again to continue.`;
				}
				if (result.capNotApplied) title += ` ${result.capNotApplied}`;
				await notifyWriter(ASSISTANT_ENRICH_QUEUE, job, userId, 'assistant_enrich', {
					title,
					href
				});
				logEvent('info', 'assistant.enrich', {
					universeId,
					entities: result.entities,
					staged: result.staged,
					failed: result.failed,
					...(result.disabled ? { disabled: true } : {}),
					...(result.noModel ? { noModel: true } : {}),
					...(result.stoppedFailing ? { stoppedFailing: true } : {})
				});
				// A pass that stopped on a problem, or could read nothing, is settled
				// as completed with a failed output, which the activity card reads as
				// failed instead of ready. pg-boss does not run it again: a retry
				// would stop the same way.
				if (result.noModel || result.disabled || result.stoppedFailing || readNothing) {
					await boss.complete(ASSISTANT_ENRICH_QUEUE, job, { failed: true });
				}
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
			const spend = await purgeJobSpend(db);
			if (spend > 0) logEvent('info', 'purge.job_spend', { removed: spend });
		},

		async purgeSessions() {
			const deleted = await purgeSessions(db);
			if (deleted > 0) logEvent('info', 'purge.sessions', { deleted });
			// External access rides the same daily sweep: expired tokens, old
			// codes, and clients nobody connected.
			const access = await purgeExternalAccess(db);
			if (access.tokens + access.codes + access.clients > 0) {
				logEvent('info', 'purge.external_access', access);
			}
		}
	};
}
