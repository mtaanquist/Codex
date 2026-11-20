// Client-side Assistant actions shared by the story page, the review pane, the
// command palette, and the review modal, so the fetch-and-feedback logic lives
// once. Server-side gating is re-checked by every endpoint; these just drive the
// requests and report progress through the activity center.
import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import type { ResolvedPathname } from '$app/types';
import { apiErrorMessage, pluralSuffix } from '#lib/format';
import {
	flashActivity,
	resolveActivity,
	startActivity,
	trackJob,
	type JobScope,
	labelJob
} from '#lib/activity.svelte';
import type { PatternScope, ReviewCategory } from '#lib/review-shape';
import { withQuery } from '#lib/href';

// Asks the Assistant to review one scene inline. Stages comments and suggested
// edits, then opens the review page when anything was staged. An empty category
// set is the sparing pass; a non-empty set is an exhaustive pass over those
// categories.
export async function reviewSceneWithAssistant(
	sceneId: string,
	reviewHref: ResolvedPathname,
	categories: ReviewCategory[] = [],
	label = 'this scene'
): Promise<void> {
	const activityId = startActivity(`Reviewing ${label}...`);
	let response: Response;
	try {
		response = await fetch('/api/assistant/review', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ sceneId, categories })
		});
	} catch {
		resolveActivity(activityId, {
			state: 'failed',
			label: 'The Assistant could not review the scene',
			detail: 'Check your connection and try again.'
		});
		return;
	}
	if (!response.ok) {
		resolveActivity(activityId, {
			state: 'failed',
			label: 'The Assistant could not review the scene',
			detail: await apiErrorMessage(response, 'The Assistant could not review the scene.')
		});
		return;
	}
	const { staged } = (await response.json()) as { staged: number };
	if (staged > 0) {
		resolveActivity(activityId, {
			state: 'done',
			label: `Review ready: ${staged} note${pluralSuffix(staged)}`,
			detail: 'Open the review page to read them.',
			href: reviewHref
		});
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- callers pass a resolve() path; lint has no type information in .ts files
		await goto(reviewHref);
	} else {
		resolveActivity(activityId, {
			state: 'done',
			label: 'Reviewed',
			detail: 'The Assistant read the scene and had no notes to add.'
		});
	}
}

// Why a job never got a job id. 'network' means the request never landed;
// 'rejected' means the server refused to queue it (including the duplicate that
// is coalesced into a run already going). The message is what the server said,
// so a caller can show it rather than guessing.
export type JobStartFailure = {
	reason: 'network' | 'rejected';
	status?: number;
	message: string;
};

// Handed the queued job id so a caller can follow the job's own progress
// alongside the activity card. A null id always comes with the reason it is
// null, so a caller can tell "never started" from "finished with nothing".
export type JobIdHandler = (jobId: string | null, failure?: JobStartFailure) => void;

// Posts to a job endpoint and tracks the queued job to completion in the
// activity center, flashing a failure card if the request never lands. A 409
// means the same job is already queued or running: the card for that job is
// picked up instead. The
// caller supplies the endpoint, its payload, the activity labels, and the
// fallback messages for a network blip and a server rejection.
async function launchJob(opts: {
	url: string;
	payload: unknown;
	kind: Parameters<typeof trackJob>[0]['kind'];
	failLabel: string;
	startFallback: string;
	track: Omit<Parameters<typeof trackJob>[0], 'jobId' | 'kind'>;
	onJobId?: JobIdHandler;
}): Promise<void> {
	let response: Response;
	try {
		response = await fetch(opts.url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(opts.payload)
		});
	} catch {
		const message = 'Check your connection and try again.';
		opts.onJobId?.(null, { reason: 'network', message });
		flashActivity('failed', opts.failLabel, message);
		return;
	}
	if (!response.ok) {
		const message = await apiErrorMessage(response, opts.startFallback);
		opts.onJobId?.(null, { reason: 'rejected', status: response.status, message });
		if (response.status === 409) {
			// The request joined a job that is already queued or running, so its own
			// card is shown rather than a failure.
			flashActivity('done', 'Already running', message);
			void resumeRunningJobs();
			return;
		}
		flashActivity('failed', opts.failLabel, message);
		return;
	}
	const { jobId } = (await response.json()) as { jobId: string | null };
	if (jobId) opts.onJobId?.(jobId);
	else opts.onJobId?.(null, { reason: 'rejected', message: opts.startFallback });
	await trackJob({ jobId, kind: opts.kind, ...opts.track });
}

// Queues a whole-chapter or whole-story review (a background job, too long to
// run inline) and tracks it to completion in the activity center. The writer is
// also notified when its notes land on the review page.
export async function startBackgroundReview(opts: {
	storyId: string;
	chapterId?: string;
	categories: ReviewCategory[];
	patterns?: PatternScope;
	label: string;
	reviewHref: string;
	onJobId?: JobIdHandler;
}): Promise<void> {
	await launchJob({
		url: '/api/assistant/review-job',
		payload: {
			storyId: opts.storyId,
			chapterId: opts.chapterId,
			categories: opts.categories,
			patterns: opts.patterns
		},
		kind: 'review',
		onJobId: opts.onJobId,
		failLabel: `Could not review ${opts.label}`,
		startFallback: 'Could not start the review.',
		track: {
			...jobLabels('review', 'full', opts.label),
			scope: { storyId: opts.storyId, chapterId: opts.chapterId, mode: 'full' },
			href: opts.reviewHref
		}
	});
}

// Queues a standalone continuity pass and tracks it to completion. A story
// focus checks one story; the universe surface checks every story against the
// others. Findings stage as review notes on the owning story's scenes, and the
// writer is notified when they land.
export async function startContinuityReview(opts: {
	scope: { storyId: string } | { universeId: string };
	label: string;
	reviewHref?: string;
}): Promise<void> {
	await launchJob({
		url: '/api/assistant/review-job',
		payload: { ...opts.scope, mode: 'continuity' },
		kind: 'review',
		failLabel: `Could not check continuity in ${opts.label}`,
		startFallback: 'Could not start the continuity pass.',
		track: {
			...jobLabels('review', 'continuity', opts.label),
			scope: { ...opts.scope, mode: 'continuity' },
			href: opts.reviewHref
		}
	});
}

// Kicks off the background summary pass and tracks it to completion in the
// activity center; the writer is also notified when it ends.
export async function startSummariesJob(storyId: string): Promise<void> {
	await launchJob({
		url: '/api/assistant/summaries-job',
		payload: { storyId },
		kind: 'summaries',
		failLabel: 'Could not update summaries',
		startFallback: 'Could not start the summary pass.',
		track: { ...jobLabels('summaries', 'full'), scope: { storyId } }
	});
}

// Kicks off the background enrichment pass over a universe's entries (the story
// focus runs over its universe) and tracks it in the activity center; the writer
// is also notified when it ends.
export async function startEnrichJob(
	scope: { storyId: string } | { universeId: string },
	label: string
): Promise<void> {
	await launchJob({
		url: '/api/assistant/enrich-job',
		payload: scope,
		kind: 'enrich',
		failLabel: `Could not suggest details for ${label}`,
		startFallback: 'Could not start the pass.',
		track: { ...jobLabels('enrich', 'full', label), scope }
	});
}

// Queues a rewrite of one character's arc and waits for it to finish, tracked
// in the activity center. Resolves when the job settles, so the caller can
// reload the page data to show the new arc.
export async function startArcJob(opts: {
	characterId: string;
	universeId: string;
	name: string;
}): Promise<void> {
	await launchJob({
		url: '/api/assistant/arc-job',
		payload: { characterId: opts.characterId },
		kind: 'arc',
		failLabel: `Could not write the arc for ${opts.name}`,
		startFallback: 'Could not start writing the arc.',
		track: { ...jobLabels('arc', 'full', opts.name), scope: { universeId: opts.universeId } }
	});
}

// Queues a full-text read of one entry (the "Suggest details" button) and
// waits for it to finish, tracked in the activity center. Resolves when the
// job settles, so the caller can reload the page data to show the suggestions.
// request is how the endpoint is told the scope (a universe by id or slug).
export async function startDetailsJob(opts: {
	entityId: string;
	request: { storyId: string } | { universeId: string };
	scope: { storyId: string } | { universeId: string };
	mode: 'scenes' | 'book';
	name: string;
}): Promise<void> {
	await launchJob({
		url: '/api/assistant/enrich',
		payload: { ...opts.request, entityId: opts.entityId, mode: opts.mode },
		kind: 'details',
		failLabel: `Could not suggest details for ${opts.name}`,
		startFallback: 'Could not start the read.',
		track: { ...jobLabels('details', 'full', opts.name), scope: opts.scope }
	});
}

// Where a scene's draft shows: the scene in Write, with the draft open in the
// Assistant panel.
export function sceneDraftPath(storyId: string, sceneId: string): ResolvedPathname {
	return withQuery(resolve('/stories/[id]', { id: storyId }), { scene: sceneId, draft: '1' });
}

// Asks for a scene draft. The server stages the draft and queues the job that
// writes it; the returned promise settles when that job does, so the caller
// can read the draft back. A refusal comes back as the server's own words.
export async function startSceneDraft(opts: {
	storyId: string;
	sceneId: string;
	brief: string;
	targetWords: number;
	pov: string;
	label: string;
}): Promise<{ ok: true; jobId: string; done: Promise<void> } | { ok: false; message: string }> {
	let response: Response;
	try {
		response = await fetch('/api/assistant/draft', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				storyId: opts.storyId,
				sceneId: opts.sceneId,
				brief: opts.brief,
				targetWords: opts.targetWords,
				pov: opts.pov
			})
		});
	} catch {
		return { ok: false, message: 'Check your connection and try again.' };
	}
	if (!response.ok) {
		return { ok: false, message: await apiErrorMessage(response, 'Could not start the draft.') };
	}
	const { jobId } = (await response.json()) as { jobId: string };
	return { ok: true, jobId, done: followSceneDraft({ ...opts, jobId }) };
}

// Follows a scene draft's job in the activity center, for one just started or
// one found still running after a reload.
export function followSceneDraft(opts: {
	jobId: string;
	storyId: string;
	sceneId: string;
	label: string;
}): Promise<void> {
	return trackJob({
		jobId: opts.jobId,
		kind: 'draft',
		...jobLabels('draft', 'full', opts.label),
		scope: { storyId: opts.storyId, sceneId: opts.sceneId },
		href: sceneDraftPath(opts.storyId, opts.sceneId)
	});
}

// The activity card's three labels for a job. label names what the job is over
// ("your story", or a quoted title for a job picked up after a reload); a
// summary pass started from the panel needs none.
function jobLabels(
	kind: 'review' | 'summaries' | 'enrich' | 'arc' | 'details' | 'draft',
	mode: 'full' | 'continuity',
	label?: string
): { runningLabel: string; doneLabel: string; failedLabel: string } {
	if (kind === 'draft') {
		return {
			runningLabel: `Drafting ${label}...`,
			doneLabel: `Draft of ${label} ready`,
			failedLabel: `Could not draft ${label}`
		};
	}
	if (kind === 'details') {
		return {
			runningLabel: `Reading your story for details about ${label}...`,
			// A finished read may have found nothing new; the notification says.
			doneLabel: `Finished reading for details about ${label}`,
			failedLabel: `Could not suggest details for ${label}`
		};
	}
	if (kind === 'arc') {
		return {
			runningLabel: `Writing the arc for ${label}...`,
			// The job may write the arc, find it up to date, or find it changed
			// again while it checked; the notification says which.
			doneLabel: `Finished with the arc for ${label}`,
			failedLabel: `Could not write the arc for ${label}`
		};
	}
	if (kind === 'enrich') {
		return {
			runningLabel: `Suggesting details for the entries in ${label}...`,
			// A finished pass may have found nothing new; the notification says.
			doneLabel: `Finished suggesting details for the entries in ${label}`,
			failedLabel: `Could not suggest details for ${label}`
		};
	}
	if (kind === 'summaries') {
		const of = label ? ` for ${label}` : '';
		return {
			runningLabel: `Updating summaries${of}...`,
			doneLabel: `Summaries${of} updated`,
			failedLabel: `Could not update summaries${of}`
		};
	}
	if (mode === 'continuity') {
		return {
			runningLabel: `Checking continuity in ${label}...`,
			doneLabel: `Continuity check of ${label} ready`,
			failedLabel: `Could not check continuity in ${label}`
		};
	}
	return {
		runningLabel: `Reviewing ${label}...`,
		doneLabel: `Review of ${label} ready`,
		failedLabel: `Could not review ${label}`
	};
}

// A job the server still has queued or running (GET /api/assistant/jobs).
export type RunningJob = JobScope & {
	id: string;
	kind: 'review' | 'summaries' | 'enrich' | 'arc' | 'details' | 'draft';
	mode: 'full' | 'continuity';
	title: string;
	startedAt?: string;
};

// Picks up the writer's unfinished Assistant jobs after a page load, so their
// activity cards and the story's run note come back. Jobs this tab already
// follows are skipped by trackJob.
export async function resumeRunningJobs(): Promise<void> {
	let jobs: RunningJob[];
	try {
		const response = await fetch('/api/assistant/jobs');
		if (!response.ok) return;
		jobs = ((await response.json()) as { jobs: RunningJob[] }).jobs;
	} catch {
		return;
	}
	for (const job of jobs) {
		const { id, kind, mode, title, storyId, chapterId, sceneId, universeId } = job;
		const queued = job.startedAt ? Date.parse(job.startedAt) : NaN;
		const labels = jobLabels(kind, mode, `"${title}"`);
		void trackJob({
			jobId: id,
			kind,
			startedAt: Number.isFinite(queued) ? queued : undefined,
			scope: { storyId, chapterId, sceneId, universeId, mode },
			...labels,
			href:
				kind === 'review' && storyId
					? resolve('/stories/[id]/review', { id: storyId })
					: kind === 'draft' && storyId && sceneId
						? sceneDraftPath(storyId, sceneId)
						: undefined
		});
		// One this tab started itself gets its title in the background jobs list.
		labelJob(id, labels.runningLabel);
	}
}

// How soon a tab coming back into view checks for new jobs again.
const RECHECK_AFTER_MS = 10_000;

// Resumes the running jobs now, and again whenever the tab comes back into
// view, so a job started in another tab shows here as well. Returns the
// cleanup that stops listening.
export function watchRunningJobs(): () => void {
	let lastCheck = Date.now();
	void resumeRunningJobs();
	const onVisible = () => {
		if (document.visibilityState !== 'visible') return;
		if (Date.now() - lastCheck < RECHECK_AFTER_MS) return;
		lastCheck = Date.now();
		void resumeRunningJobs();
	};
	document.addEventListener('visibilitychange', onVisible);
	return () => document.removeEventListener('visibilitychange', onVisible);
}
