// A small client-side activity center, in the spirit of the Azure portal's
// notifications: a task that is starting shows here with a spinner and stays
// until it finishes, then flips to done or failed and dismisses itself. Unlike
// the notification bell (server-backed and persistent), this tracks the work
// happening right now, so the writer can see something is still going.
//
// Lives here like assistant.svelte.ts so any surface can raise an activity. The
// ActivityCenter component renders the list from #lib/components.

export type ActivityState = 'running' | 'done' | 'failed';

export type ActivityItem = {
	id: number;
	label: string;
	detail?: string;
	state: ActivityState;
	href?: string;
	startedAt: number;
	// Set on a running background job's card: stops the job.
	stop?: () => void;
};

export const activity = $state<{ items: ActivityItem[] }>({ items: [] });

let nextId = 0;
// How long a settled (done or failed) card lingers before clearing itself.
const DISMISS_AFTER_MS = 8000;

export function startActivity(label: string, detail?: string): number {
	const id = ++nextId;
	activity.items = [
		...activity.items,
		{ id, label, detail, state: 'running', startedAt: Date.now() }
	];
	return id;
}

export function resolveActivity(
	id: number,
	patch: {
		state: ActivityState;
		label?: string;
		detail?: string;
		href?: string;
		stop?: () => void;
	}
): void {
	activity.items = activity.items.map((item) => (item.id === id ? { ...item, ...patch } : item));
	if (patch.state !== 'running') {
		setTimeout(() => dismissActivity(id), DISMISS_AFTER_MS);
	}
}

export function dismissActivity(id: number): void {
	activity.items = activity.items.filter((item) => item.id !== id);
}

// A one-shot card for an outcome with no waiting (a done message, or an error):
// it appears already settled and dismisses itself.
export function flashActivity(
	state: 'done' | 'failed',
	label: string,
	detail?: string,
	href?: string
): void {
	const id = startActivity(label, detail);
	resolveActivity(id, { state, label, detail, href });
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The Assistant jobs this tab is following, by job id, with their latest
// progress. Separate from the cards so dismissing a card does not hide the run
// from the story's mode strip (RunningJobsNote), which reads this list.
export type JobScope = {
	storyId?: string | null;
	chapterId?: string | null;
	universeId?: string | null;
	mode?: 'full' | 'continuity';
};

export type JobProgress = {
	phase: 'summaries' | 'scenes' | 'consistency' | 'done';
	completed: number;
	total: number;
};

export type TrackedJob = JobScope & {
	id: string;
	kind: 'review' | 'summaries' | 'enrich' | 'arc';
	progress?: JobProgress;
};

export const trackedJobs = $state<{ list: TrackedJob[] }>({ list: [] });

function updateJob(id: string, patch: Partial<TrackedJob>): void {
	trackedJobs.list = trackedJobs.list.map((job) => (job.id === id ? { ...job, ...patch } : job));
}

// How often a running job is polled: briskly at first, then less often for a
// long run, which can take hours on local hardware.
const POLL_MS = 3000;
const SLOW_POLL_MS = 15000;
const SLOW_AFTER_MS = 5 * 60 * 1000;

// A hidden tab does not poll: it waits until it is shown again, then checks
// at once. Every open tab follows every running job, so this keeps the
// requests to the tabs someone is looking at.
function whenVisible(): Promise<void> {
	if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		const onChange = () => {
			if (document.visibilityState === 'hidden') return;
			document.removeEventListener('visibilitychange', onChange);
			resolve();
		};
		document.addEventListener('visibilitychange', onChange);
	});
}

// The jobs this tab follows, so a second call for the same job waits on the
// first rather than returning at once.
const following: Record<string, Promise<void>> = {};

// Polls a queued background job (review, summaries, or enrichment) to completion, driving one
// activity card from running to done or failed. When the enqueue could not hand
// back a job id (a coalesced singleton, say), it shows the work as accepted and
// leaves the notification bell to announce the result. A job this tab already
// follows is not tracked twice: the second call settles with the first.
type TrackOptions = {
	jobId: string | null;
	kind: 'review' | 'summaries' | 'enrich' | 'arc';
	scope?: JobScope;
	runningLabel: string;
	doneLabel: string;
	failedLabel: string;
	href?: string;
};

export function trackJob(opts: TrackOptions): Promise<void> {
	const jobId = opts.jobId;
	if (!jobId) return followJob(opts, null);
	if (trackedJobs.list.some((job) => job.id === jobId)) {
		return following[jobId] ?? Promise.resolve();
	}
	const run = followJob(opts, jobId).finally(() => {
		if (following[jobId] === run) delete following[jobId];
	});
	following[jobId] = run;
	return run;
}

async function followJob(opts: TrackOptions, jobId: string | null): Promise<void> {
	const id = startActivity(opts.runningLabel);
	// The writer's last Stop, resolving true once the queue took it. A job that
	// ends while it is in flight waits for the answer, so a job that finished
	// on its own is not shown as stopped.
	let stopRequest: Promise<boolean> | undefined;
	const requestStop = async (): Promise<boolean> => {
		resolveActivity(id, { state: 'running', detail: 'Stopping...', stop: undefined });
		let message: string;
		try {
			const response = await fetch('/api/assistant/job-stop', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ id: jobId })
			});
			if (response.ok) return true;
			// Already settled: the next poll shows how it ended.
			if (response.status === 404) {
				resolveActivity(id, { state: 'running', detail: undefined });
				return false;
			}
			message = 'Could not stop it. Try again in a moment.';
		} catch {
			message = 'Could not stop it. Check your connection and try again.';
		}
		resolveActivity(id, { state: 'running', detail: message, stop });
		return false;
	};
	const stop = () => {
		stopRequest = requestStop();
	};
	if (!jobId) {
		resolveActivity(id, {
			state: 'done',
			label: opts.doneLabel,
			detail: 'Running in the background. You will be notified when it is ready.',
			href: opts.href
		});
		return;
	}
	trackedJobs.list = [...trackedJobs.list, { id: jobId, kind: opts.kind, ...opts.scope }];
	resolveActivity(id, { state: 'running', stop });
	const startedAt = Date.now();
	try {
		for (;;) {
			await delay(Date.now() - startedAt < SLOW_AFTER_MS ? POLL_MS : SLOW_POLL_MS);
			await whenVisible();
			let state: ActivityState | 'stale' = 'running';
			try {
				const response = await fetch(
					`/api/assistant/job-status?kind=${opts.kind}&id=${encodeURIComponent(jobId)}`
				);
				// Signed out, or the job is not this writer's: this page can no
				// longer follow it, so stop rather than poll for good.
				if ([401, 403, 404].includes(response.status)) {
					resolveActivity(id, {
						state: 'failed',
						stop: undefined,
						label: opts.runningLabel.replace(/\.\.\.$/, ''),
						detail: 'Could not check on it from this page. You will be notified when it is ready.'
					});
					return;
				}
				if (response.ok) {
					const body = (await response.json()) as {
						state: ActivityState | 'stale';
						phase?: JobProgress['phase'];
						completed?: number;
						total?: number;
					};
					state = body.state;
					if (body.phase) {
						updateJob(jobId, {
							progress: {
								phase: body.phase,
								completed: body.completed ?? 0,
								total: body.total ?? 0
							}
						});
					}
				}
			} catch {
				// A blip leaves the card running; the next poll catches up.
			}
			// A cancelled job reads as failed; one that finished anyway is done.
			const stopped =
				state !== 'running' && stopRequest !== undefined && (await stopRequest) && state !== 'done';
			if (stopped) {
				resolveActivity(id, {
					state: 'done',
					label: `${opts.runningLabel.replace(/\.\.\.$/, '')}: stopped`,
					detail: undefined,
					stop: undefined
				});
				return;
			}
			if (state === 'done') {
				resolveActivity(id, {
					state: 'done',
					label: opts.doneLabel,
					href: opts.href,
					stop: undefined
				});
				return;
			}
			if (state === 'failed' || state === 'stale') {
				resolveActivity(id, {
					state: 'failed',
					stop: undefined,
					label: opts.failedLabel,
					// A stale run was dropped by the queue part-way and will not finish.
					detail:
						state === 'stale'
							? 'It stopped before it finished. Run it again to continue.'
							: 'Check the Assistant endpoint in your settings.'
				});
				return;
			}
		}
	} finally {
		trackedJobs.list = trackedJobs.list.filter((job) => job.id !== jobId);
	}
}
