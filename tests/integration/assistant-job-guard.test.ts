import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { PgBoss, type JobWithMetadata } from 'pg-boss';
import { shouldNotifyWriter } from '../../src/worker/job-guard';
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
