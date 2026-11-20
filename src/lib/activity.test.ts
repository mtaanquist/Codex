import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { activity, trackJob, trackedJobs } from './activity.svelte';

// trackJob polls the job-status endpoint; the replies are scripted per call.
function scriptStatus(replies: object[]) {
	const fetch = vi.fn(async () => {
		const body = replies.length > 1 ? replies.shift() : replies[0];
		return new Response(JSON.stringify(body), { status: 200 });
	});
	vi.stubGlobal('fetch', fetch);
	return fetch;
}

const labels = { runningLabel: 'Running...', doneLabel: 'Done', failedLabel: 'Failed' };

beforeEach(() => {
	vi.useFakeTimers();
	activity.items = [];
	trackedJobs.list = [];
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('trackJob', () => {
	it('keeps the job and its progress listed while it runs, and drops it when done', async () => {
		scriptStatus([
			{ state: 'running', phase: 'scenes', completed: 2, total: 5 },
			{ state: 'done', phase: 'done', completed: 5, total: 5 }
		]);
		const run = trackJob({ jobId: 'j1', kind: 'review', scope: { storyId: 's1' }, ...labels });

		// What the top bar's list shows: the label without its dots, when it
		// started, and a way to stop it.
		expect(trackedJobs.list).toHaveLength(1);
		expect(trackedJobs.list[0]).toMatchObject({
			id: 'j1',
			kind: 'review',
			storyId: 's1',
			label: 'Running',
			startedAt: Date.now()
		});
		expect(trackedJobs.list[0].stop).toBeTypeOf('function');
		await vi.advanceTimersByTimeAsync(3000);
		expect(trackedJobs.list[0].progress).toEqual({ phase: 'scenes', completed: 2, total: 5 });

		await vi.advanceTimersByTimeAsync(3000);
		await run;
		expect(trackedJobs.list).toEqual([]);
		expect(activity.items[0]).toMatchObject({ state: 'done', label: 'Done' });
	});

	it('does not follow the same job twice, and a second call settles with the first', async () => {
		scriptStatus([{ state: 'running' }, { state: 'done' }]);
		const first = trackJob({ jobId: 'j1', kind: 'summaries', ...labels });
		let secondSettled = false;
		const second = trackJob({ jobId: 'j1', kind: 'summaries', ...labels }).then(
			() => (secondSettled = true)
		);

		expect(trackedJobs.list).toHaveLength(1);
		expect(activity.items).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(3000);
		expect(secondSettled).toBe(false);
		await vi.advanceTimersByTimeAsync(3000);
		await first;
		await second;
		expect(secondSettled).toBe(true);
	});

	it('does not poll while the tab is hidden, and checks as soon as it is shown', async () => {
		const listeners = new Set<() => void>();
		const doc = {
			visibilityState: 'hidden',
			addEventListener: (_: string, fn: () => void) => listeners.add(fn),
			removeEventListener: (_: string, fn: () => void) => listeners.delete(fn)
		};
		vi.stubGlobal('document', doc);
		const fetch = scriptStatus([{ state: 'done' }]);
		const run = trackJob({ jobId: 'j1', kind: 'review', ...labels });

		await vi.advanceTimersByTimeAsync(60_000);
		expect(fetch).not.toHaveBeenCalled();
		doc.visibilityState = 'visible';
		for (const fn of [...listeners]) fn();
		await run;
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(activity.items[0]).toMatchObject({ state: 'done' });
	});

	it('keeps polling a long run instead of giving up', async () => {
		const fetch = scriptStatus([{ state: 'running' }]);
		void trackJob({ jobId: 'j1', kind: 'review', ...labels });

		await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
		expect(trackedJobs.list).toHaveLength(1);
		expect(activity.items[0].state).toBe('running');
		const calls = fetch.mock.calls.length;
		await vi.advanceTimersByTimeAsync(15000);
		expect(fetch.mock.calls.length).toBe(calls + 1);
	});

	it('reports a run the queue dropped as stopped', async () => {
		scriptStatus([{ state: 'stale', phase: 'scenes', completed: 1, total: 4 }]);
		const run = trackJob({ jobId: 'j1', kind: 'review', ...labels });
		await vi.advanceTimersByTimeAsync(3000);
		await run;

		expect(trackedJobs.list).toEqual([]);
		expect(activity.items[0]).toMatchObject({
			state: 'failed',
			detail: 'It stopped before it finished. Run it again to continue.'
		});
	});

	it('stops following a job the page can no longer check, such as after signing out', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('', { status: 401 }))
		);
		const run = trackJob({ jobId: 'j1', kind: 'review', scope: { storyId: 's1' }, ...labels });
		await vi.advanceTimersByTimeAsync(3000);
		await run;

		expect(trackedJobs.list).toEqual([]);
		expect(activity.items[0]).toMatchObject({ state: 'failed', label: 'Running' });
	});

	it('offers Stop while a job runs, and shows a stopped job as stopped (#1045)', async () => {
		const calls: string[] = [];
		let cancelled = false;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				calls.push(url);
				if (url === '/api/assistant/job-stop') {
					cancelled = true;
					return new Response(JSON.stringify({ ok: true }), { status: 200 });
				}
				return new Response(JSON.stringify({ state: cancelled ? 'failed' : 'running' }), {
					status: 200
				});
			})
		);
		const queued = Date.now() - 600_000;
		const run = trackJob({ jobId: 'j1', kind: 'summaries', startedAt: queued, ...labels });
		await vi.advanceTimersByTimeAsync(3000);
		expect(activity.items[0].stop).toBeTypeOf('function');
		// A job picked up after a reload keeps the time it was queued.
		expect(trackedJobs.list[0].startedAt).toBe(queued);

		// Stopped from the list, which carries the same stop as the card.
		trackedJobs.list[0].stop?.();
		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toContain('/api/assistant/job-stop');
		expect(activity.items[0]).toMatchObject({ state: 'running', detail: 'Stopping...' });
		expect(activity.items[0].stop).toBeUndefined();
		expect(trackedJobs.list[0]).toMatchObject({ stopping: true });
		expect(trackedJobs.list[0].stop).toBeUndefined();

		await vi.advanceTimersByTimeAsync(3000);
		await run;
		expect(activity.items[0]).toMatchObject({ state: 'done', label: 'Running: stopped' });
	});

	it('shows a job that finished while Stop was in flight as done (#1045)', async () => {
		let answerStop: (response: Response) => void = () => {};
		let finished = false;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				if (url === '/api/assistant/job-stop') {
					finished = true;
					return new Promise<Response>((resolve) => (answerStop = resolve));
				}
				return new Response(JSON.stringify({ state: finished ? 'done' : 'running' }), {
					status: 200
				});
			})
		);
		const run = trackJob({ jobId: 'j1', kind: 'summaries', ...labels });
		await vi.advanceTimersByTimeAsync(3000);
		activity.items[0].stop?.();
		// The next poll sees the job done before the stop request answers, and
		// the stop then finds nothing left to stop.
		await vi.advanceTimersByTimeAsync(3000);
		answerStop(new Response('', { status: 404 }));
		await run;
		expect(activity.items[0]).toMatchObject({ state: 'done', label: 'Done' });
	});

	it('does not call a job stopped when it finished just before the stop reached it', async () => {
		let calls = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) =>
				url === '/api/assistant/job-stop'
					? new Response(JSON.stringify({ ok: true }), { status: 200 })
					: new Response(JSON.stringify({ state: calls++ === 0 ? 'running' : 'done' }), {
							status: 200
						})
			)
		);
		const run = trackJob({ jobId: 'j1', kind: 'summaries', ...labels });
		await vi.advanceTimersByTimeAsync(3000);
		activity.items[0].stop?.();
		await vi.advanceTimersByTimeAsync(3000);
		await run;
		expect(activity.items[0]).toMatchObject({ state: 'done', label: 'Done' });
	});

	it('offers Stop again when the stop request fails', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) =>
				url === '/api/assistant/job-stop'
					? new Response('', { status: 503 })
					: new Response(JSON.stringify({ state: 'running' }), { status: 200 })
			)
		);
		void trackJob({ jobId: 'j1', kind: 'summaries', ...labels });
		await vi.advanceTimersByTimeAsync(3000);
		activity.items[0].stop?.();
		await vi.advanceTimersByTimeAsync(0);
		expect(activity.items[0]).toMatchObject({
			state: 'running',
			detail: 'Could not stop it. Try again in a moment.'
		});
		expect(activity.items[0].stop).toBeTypeOf('function');
	});
});
