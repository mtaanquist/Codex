import { describe, it, expect, beforeEach, vi } from 'vitest';

// The activity center and navigation are browser-side; the point here is what
// the caller is told about the job, so both are stubbed out.
vi.mock('$app/navigation', () => ({ goto: vi.fn(async () => {}) }));
vi.mock('#lib/activity.svelte', () => ({
	flashActivity: vi.fn(),
	resolveActivity: vi.fn(),
	startActivity: vi.fn(() => 'activity-1'),
	trackJob: vi.fn(async () => {})
}));

const { startBackgroundReview, resumeRunningJobs, watchRunningJobs } =
	await import('./assistant-actions');
const { trackJob } = await import('#lib/activity.svelte');

type Handled = { jobId: string | null; message?: string; reason?: string };

function collect(): { calls: Handled[]; onJobId: (id: string | null, f?: unknown) => void } {
	const calls: Handled[] = [];
	return {
		calls,
		onJobId: (jobId, failure) => {
			const f = failure as { message?: string; reason?: string } | undefined;
			calls.push({ jobId, message: f?.message, reason: f?.reason });
		}
	};
}

function review(onJobId: (id: string | null, f?: unknown) => void) {
	return startBackgroundReview({
		storyId: 'story-1',
		categories: [],
		label: 'your story',
		reviewHref: '/stories/x/review',
		onJobId
	});
}

describe('startBackgroundReview job start reporting', () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
	});

	it('hands the job id over when the review is queued', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(JSON.stringify({ ok: true, jobId: 'job-1' }), { status: 200 }))
		);
		const { calls, onJobId } = collect();
		await review(onJobId);
		expect(calls).toEqual([{ jobId: 'job-1', message: undefined, reason: undefined }]);
	});

	it('reports a refused start with the reason, not a silent null', async () => {
		// A duplicate that coalesces into a running review comes back as a 503, and
		// the caller has to be able to tell that from a review that finished.
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(JSON.stringify({ message: 'Could not start the review. Try again.' }), {
						status: 503
					})
			)
		);
		const { calls, onJobId } = collect();
		await review(onJobId);
		expect(calls).toHaveLength(1);
		expect(calls[0].jobId).toBeNull();
		expect(calls[0].reason).toBe('rejected');
		expect(calls[0].message).toBe('Could not start the review. Try again.');
	});

	it('reports a request that never landed', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('offline');
			})
		);
		const { calls, onJobId } = collect();
		await review(onJobId);
		expect(calls).toHaveLength(1);
		expect(calls[0].jobId).toBeNull();
		expect(calls[0].reason).toBe('network');
	});
});

describe('resumeRunningJobs', () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
		vi.mocked(trackJob).mockClear();
	});

	it('follows each job the server still has running, named by its title', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							jobs: [
								{
									id: 'j1',
									kind: 'review',
									mode: 'full',
									storyId: 's1',
									chapterId: null,
									universeId: null,
									title: 'Saltglass'
								},
								{
									id: 'j2',
									kind: 'review',
									mode: 'continuity',
									storyId: null,
									chapterId: null,
									universeId: 'u1',
									title: 'Hollow Coast'
								},
								{
									id: 'j3',
									kind: 'summaries',
									mode: 'full',
									storyId: 's1',
									chapterId: null,
									universeId: null,
									title: 'Saltglass'
								}
							]
						}),
						{ status: 200 }
					)
			)
		);
		await resumeRunningJobs();

		const calls = vi.mocked(trackJob).mock.calls.map(([opts]) => opts);
		expect(calls).toHaveLength(3);
		expect(calls[0]).toMatchObject({
			jobId: 'j1',
			kind: 'review',
			scope: { storyId: 's1', mode: 'full' },
			runningLabel: 'Reviewing "Saltglass"...'
		});
		expect(calls[0].href).toMatch(/\/stories\/s1\/review$/);
		expect(calls[1]).toMatchObject({
			runningLabel: 'Checking continuity in "Hollow Coast"...',
			href: undefined
		});
		expect(calls[2]).toMatchObject({
			kind: 'summaries',
			runningLabel: 'Updating summaries for "Saltglass"...'
		});
	});

	it('does nothing when the list cannot be read', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('', { status: 500 }))
		);
		await resumeRunningJobs();
		expect(trackJob).not.toHaveBeenCalled();
	});
});

describe('watchRunningJobs', () => {
	it('checks again when the tab comes back into view, at most every ten seconds', async () => {
		vi.useFakeTimers();
		const fetch = vi.fn(async () => new Response(JSON.stringify({ jobs: [] }), { status: 200 }));
		vi.stubGlobal('fetch', fetch);
		const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
		vi.stubGlobal('document', doc);
		const show = () => doc.dispatchEvent(new Event('visibilitychange'));

		const stop = watchRunningJobs();
		expect(fetch).toHaveBeenCalledTimes(1);

		show();
		expect(fetch).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(10_000);
		doc.visibilityState = 'hidden';
		show();
		expect(fetch).toHaveBeenCalledTimes(1);
		doc.visibilityState = 'visible';
		show();
		expect(fetch).toHaveBeenCalledTimes(2);

		stop();
		vi.advanceTimersByTime(10_000);
		show();
		expect(fetch).toHaveBeenCalledTimes(2);
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});
});
