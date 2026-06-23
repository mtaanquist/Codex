// Client-side Assistant actions shared by the story page, the review pane, the
// command palette, and the review modal, so the fetch-and-feedback logic lives
// once. Server-side gating is re-checked by every endpoint; these just drive the
// requests and report progress through the activity center.
import { goto } from '$app/navigation';
import { apiErrorMessage, pluralSuffix } from '$lib/format';
import { flashActivity, resolveActivity, startActivity, trackJob } from '$lib/activity.svelte';
import type { ReviewCategory } from '$lib/review-shape';

// Asks the Assistant to review one scene inline. Stages comments and suggested
// edits, then opens the review page when anything was staged. An empty category
// set is the sparing pass; a non-empty set is an exhaustive pass over those
// categories.
export async function reviewSceneWithAssistant(
	sceneId: string,
	reviewHref: string,
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
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- app path from a slug
		await goto(reviewHref);
	} else {
		resolveActivity(activityId, {
			state: 'done',
			label: 'Reviewed',
			detail: 'The Assistant read the scene and had no notes to add.'
		});
	}
}

// Posts to a job endpoint and tracks the queued job to completion in the
// activity center, flashing a failure card if the request never lands. The
// caller supplies the endpoint, its payload, the activity labels, and the
// fallback messages for a network blip and a server rejection.
async function launchJob(opts: {
	url: string;
	payload: unknown;
	kind: Parameters<typeof trackJob>[0]['kind'];
	failLabel: string;
	startFallback: string;
	track: Omit<Parameters<typeof trackJob>[0], 'jobId' | 'kind'>;
}): Promise<void> {
	let response: Response;
	try {
		response = await fetch(opts.url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(opts.payload)
		});
	} catch {
		flashActivity('failed', opts.failLabel, 'Check your connection and try again.');
		return;
	}
	if (!response.ok) {
		flashActivity('failed', opts.failLabel, await apiErrorMessage(response, opts.startFallback));
		return;
	}
	const { jobId } = (await response.json()) as { jobId: string | null };
	await trackJob({ jobId, kind: opts.kind, ...opts.track });
}

// Queues a whole-chapter or whole-story review (a background job, too long to
// run inline) and tracks it to completion in the activity center. The writer is
// also notified when its notes land on the review page.
export async function startBackgroundReview(opts: {
	storyId: string;
	chapterId?: string;
	categories: ReviewCategory[];
	label: string;
	reviewHref: string;
}): Promise<void> {
	await launchJob({
		url: '/api/assistant/review-job',
		payload: { storyId: opts.storyId, chapterId: opts.chapterId, categories: opts.categories },
		kind: 'review',
		failLabel: `Could not review ${opts.label}`,
		startFallback: 'Could not start the review.',
		track: {
			runningLabel: `Reviewing ${opts.label}...`,
			doneLabel: `Review of ${opts.label} ready`,
			failedLabel: `Could not review ${opts.label}`,
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
			runningLabel: `Checking continuity in ${opts.label}...`,
			doneLabel: `Continuity check of ${opts.label} ready`,
			failedLabel: `Could not check continuity in ${opts.label}`,
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
		track: {
			runningLabel: 'Updating summaries...',
			doneLabel: 'Summaries updated',
			failedLabel: 'Could not update summaries'
		}
	});
}
