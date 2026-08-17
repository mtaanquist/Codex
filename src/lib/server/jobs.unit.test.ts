import { describe, it, expect, vi, beforeEach } from 'vitest';

// The send options are the contract under test, so pg-boss is stood in for and
// the calls are read back off it.
const sends: { queue: string; data: unknown; options: Record<string, unknown> }[] = [];

vi.mock('pg-boss', () => ({
	PgBoss: class {
		on() {}
		async start() {}
		async createQueue() {}
		async send(queue: string, data: unknown, options: Record<string, unknown> = {}) {
			sends.push({ queue, data, options });
			return 'job-id';
		}
	}
}));

const { queueAssistantReview, queueAssistantSummaries, reviewJobState, ASSISTANT_REVIEW_QUEUE } =
	await import('./jobs');
const { ASSISTANT_JOB_EXPIRY_SECONDS } = await import('./queues');
const { reviewScopeKey } = await import('./review-runs');

beforeEach(() => {
	sends.length = 0;
});

describe('Assistant job send options (long runs)', () => {
	it('gives a queued review hours to run rather than the 15-minute default', async () => {
		await queueAssistantReview({ userId: 'u', storyId: 's', categories: [] });

		expect(sends[0].queue).toBe(ASSISTANT_REVIEW_QUEUE);
		expect(sends[0].options.expireInSeconds).toBe(ASSISTANT_JOB_EXPIRY_SECONDS);
		expect(ASSISTANT_JOB_EXPIRY_SECONDS).toBeGreaterThanOrEqual(3600);
	});

	it('leaves a retry limit in place so a crashed run is picked up again', async () => {
		await queueAssistantReview({ userId: 'u', storyId: 's', categories: [] });
		await queueAssistantSummaries({ userId: 'u', storyId: 's' });

		for (const send of sends) expect(send.options.retryLimit).toBeGreaterThan(0);
	});

	it('gives the summaries job the same expiry', async () => {
		await queueAssistantSummaries({ userId: 'u', storyId: 's' });

		expect(sends[0].options.expireInSeconds).toBe(ASSISTANT_JOB_EXPIRY_SECONDS);
	});

	it('holds one unfinished review per scope, keyed the way a run records it', async () => {
		await queueAssistantReview({ userId: 'u', storyId: 's', chapterId: 'c', categories: [] });

		expect(sends[0].options.singletonKey).toBe(reviewScopeKey({ storyId: 's', chapterId: 'c' }));
	});
});

describe('reviewJobState', () => {
	it('calls a forgotten job with unfinished progress stale, not done', () => {
		expect(reviewJobState('done', 'scenes')).toBe('stale');
		expect(reviewJobState('done', 'summaries')).toBe('stale');
	});

	it('leaves a finished run and a live one alone', () => {
		expect(reviewJobState('done', 'done')).toBe('done');
		expect(reviewJobState('running', 'scenes')).toBe('running');
		expect(reviewJobState('failed', 'scenes')).toBe('failed');
	});
});

describe('reviewScopeKey', () => {
	it('names the mode and the target', () => {
		expect(reviewScopeKey({ storyId: 's' })).toBe('full:s');
		expect(reviewScopeKey({ storyId: 's', chapterId: 'c' })).toBe('full:s:c');
		expect(reviewScopeKey({ storyId: 's', mode: 'continuity' })).toBe('continuity:s');
		expect(reviewScopeKey({ universeId: 'u', mode: 'continuity' })).toBe('continuity:universe:u');
	});
});
