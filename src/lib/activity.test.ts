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

		expect(trackedJobs.list).toEqual([{ id: 'j1', kind: 'review', storyId: 's1' }]);
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
});
