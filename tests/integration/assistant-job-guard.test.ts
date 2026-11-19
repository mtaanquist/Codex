import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { PgBoss, type JobWithMetadata } from 'pg-boss';
import { jobRunSignal, shouldNotifyWriter, withJobRunSignal } from '../../src/worker/job-guard';
import { stoppedByWriter } from '../../src/lib/server/llm/providers/types';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

// Against a real pg-boss, because the guard leans on how it re-queues a failed
// job: same id, state 'retry', and a fresh start time when it is picked up again.
const QUEUE = 'assistant-job-guard-test';
let boss: PgBoss;

beforeAll(async () => {
	await ensureTestDatabase();
	boss = new PgBoss({ connectionString: TEST_DATABASE_URL, supervise: false, schedule: false });
	boss.on('error', (error) => console.error(error));
	await boss.start();
	await boss.createQueue(QUEUE);
});

beforeEach(async () => {
	await boss.deleteAllJobs(QUEUE);
});

afterAll(async () => {
	await boss.deleteQueue(QUEUE);
	await boss.stop({ graceful: false });
});

async function startRun(retryLimit = 2): Promise<JobWithMetadata> {
	await boss.send(QUEUE, {}, { retryLimit, retryDelay: 0 });
	const [job] = await boss.fetch<object>(QUEUE, { includeMetadata: true });
	return job;
}

const live = () => new AbortController().signal;
const aborted = () => AbortSignal.abort();

describe('shouldNotifyWriter', () => {
	it('notifies when the run still holds its job', async () => {
		const job = await startRun();
		expect(await shouldNotifyWriter(boss, QUEUE, { ...job, signal: live() })).toBe(true);
	});

	it('stays quiet when a lapsed heartbeat moved the job to a retry', async () => {
		const job = await startRun();
		await boss.fail(QUEUE, job.id, { message: 'job heartbeat timeout' });

		expect(await shouldNotifyWriter(boss, QUEUE, { ...job, signal: live() })).toBe(false);
	});

	it('stays quiet when the retry is already running elsewhere', async () => {
		const first = await startRun();
		await boss.fail(QUEUE, first.id, { message: 'job heartbeat timeout' });
		// Distinct start times need the clock to move between the two fetches.
		await new Promise((resolve) => setTimeout(resolve, 5));
		const [retry] = await boss.fetch(QUEUE, { includeMetadata: true });
		expect(retry.id).toBe(first.id);

		expect(await shouldNotifyWriter(boss, QUEUE, { ...first, signal: live() })).toBe(false);
		expect(await shouldNotifyWriter(boss, QUEUE, { ...retry, signal: live() })).toBe(true);
	});

	it('notifies when the lapse used up the last retry, since nothing follows', async () => {
		const job = await startRun(0);
		await boss.fail(QUEUE, job.id, { message: 'job heartbeat timeout' });

		expect(await shouldNotifyWriter(boss, QUEUE, { ...job, signal: live() })).toBe(true);
	});

	it('stays quiet when pg-boss aborted the run with retries left', async () => {
		const job = await startRun();
		expect(await shouldNotifyWriter(boss, QUEUE, { ...job, signal: aborted() })).toBe(false);
	});

	it('notifies when pg-boss aborted the last attempt', async () => {
		const job = await startRun(0);
		expect(await shouldNotifyWriter(boss, QUEUE, { ...job, signal: aborted() })).toBe(true);
	});
});

describe('jobRunSignal', () => {
	// The run signal once the job's own signal aborts.
	async function abortedRun(job: JobWithMetadata) {
		const controller = new AbortController();
		const { signal } = jobRunSignal(boss, QUEUE, { ...job, signal: controller.signal });
		expect(signal.aborted).toBe(false);
		controller.abort();
		await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
		return signal;
	}

	it('passes on a Stop from the writer, which cancels the job', async () => {
		const job = await startRun();
		await boss.cancel(QUEUE, job.id);
		expect(stoppedByWriter(await abortedRun(job))).toBe(true);
	});

	it('does not call an expired job a writer stop, since it runs again', async () => {
		const job = await startRun();
		await boss.fail(QUEUE, job.id, { message: 'job timed out' });
		expect(stoppedByWriter(await abortedRun(job))).toBe(false);
	});

	it('does not call a worker shutdown a writer stop', async () => {
		const job = await startRun();
		expect(stoppedByWriter(await abortedRun(job))).toBe(false);
	});

	it('skips the job lookup once the work has returned', async () => {
		let lookups = 0;
		const counting = { getJobById: async () => (lookups++, null) };
		const controller = new AbortController();
		const job = { id: 'job-1', name: QUEUE, signal: controller.signal };
		let runSignal: AbortSignal | undefined;
		await withJobRunSignal(counting, job, async (signal) => {
			runSignal = signal;
		});
		// pg-boss aborts the job's signal when it completes normally.
		controller.abort();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(lookups).toBe(0);
		expect(runSignal?.aborted).toBe(false);
	});
});
