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

const labels = { runningLabel: 'Running', doneLabel: 'Done', failedLabel: 'Failed' };

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

	it('does not follow the same job twice', async () => {
		scriptStatus([{ state: 'running' }]);
		void trackJob({ jobId: 'j1', kind: 'summaries', ...labels });
		await trackJob({ jobId: 'j1', kind: 'summaries', ...labels });

		expect(trackedJobs.list).toHaveLength(1);
		expect(activity.items).toHaveLength(1);
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
});
