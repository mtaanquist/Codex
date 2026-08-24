import { describe, it, expect, beforeEach, vi } from 'vitest';

// The activity center and navigation are browser-side; the point here is what
// the caller is told about the job, so both are stubbed out.
vi.mock('$app/navigation', () => ({ goto: vi.fn(async () => {}) }));
vi.mock('$lib/activity.svelte', () => ({
	flashActivity: vi.fn(),
	resolveActivity: vi.fn(),
	startActivity: vi.fn(() => 'activity-1'),
	trackJob: vi.fn(async () => {})
}));

const { startBackgroundReview } = await import('./assistant-actions');

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
