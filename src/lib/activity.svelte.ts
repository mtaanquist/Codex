// A small client-side activity center, in the spirit of the Azure portal's
// notifications: a task that is starting shows here with a spinner and stays
// until it finishes, then flips to done or failed and dismisses itself. Unlike
// the notification bell (server-backed and persistent), this tracks the work
// happening right now, so the writer can see something is still going.
//
// Lives here like assistant.svelte.ts so any surface can raise an activity. The
// ActivityCenter component renders the list from $lib/components.

export type ActivityState = 'running' | 'done' | 'failed';

export type ActivityItem = {
	id: number;
	label: string;
	detail?: string;
	state: ActivityState;
	href?: string;
	startedAt: number;
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
	patch: { state: ActivityState; label?: string; detail?: string; href?: string }
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

// Polls a queued background job (review or summaries) to completion, driving one
// activity card from running to done or failed. When the enqueue could not hand
// back a job id (a coalesced singleton, say), it shows the work as accepted and
// leaves the notification bell to announce the result.
export async function trackJob(opts: {
	jobId: string | null;
	kind: 'review' | 'summaries';
	runningLabel: string;
	doneLabel: string;
	failedLabel: string;
	href?: string;
}): Promise<void> {
	const id = startActivity(opts.runningLabel);
	if (!opts.jobId) {
		resolveActivity(id, {
			state: 'done',
			label: opts.doneLabel,
			detail: 'Running in the background. You will be notified when it is ready.',
			href: opts.href
		});
		return;
	}
	const POLL_MS = 3000;
	const TIMEOUT_MS = 15 * 60 * 1000;
	const startedAt = Date.now();
	while (Date.now() - startedAt < TIMEOUT_MS) {
		await delay(POLL_MS);
		let state: ActivityState = 'running';
		try {
			const response = await fetch(
				`/api/assistant/job-status?kind=${opts.kind}&id=${encodeURIComponent(opts.jobId)}`
			);
			if (response.ok) state = ((await response.json()) as { state: ActivityState }).state;
		} catch {
			// A blip leaves the card running; the next poll catches up.
		}
		if (state === 'done') {
			resolveActivity(id, { state: 'done', label: opts.doneLabel, href: opts.href });
			return;
		}
		if (state === 'failed') {
			resolveActivity(id, {
				state: 'failed',
				label: opts.failedLabel,
				detail: 'Check the Assistant endpoint in your settings.'
			});
			return;
		}
	}
	// Stopped waiting after a long run; let the notification bell carry the result.
	resolveActivity(id, {
		state: 'done',
		label: opts.doneLabel,
		detail: 'Still finishing. You will be notified when it is ready.',
		href: opts.href
	});
}
