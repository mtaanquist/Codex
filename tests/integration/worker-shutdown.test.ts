import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PgBoss } from 'pg-boss';
import { stopWorker } from '../../src/worker/shutdown';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

// A job still running when the worker stops must come out of 'active' before
// the process exits, or it sits there until it expires (hours for an Assistant
// run) and its singleton key blocks a fresh request.
const QUEUE = 'worker-shutdown-test';
let inspector: PgBoss;

const newBoss = () =>
	new PgBoss({ connectionString: TEST_DATABASE_URL, supervise: false, schedule: false });

beforeAll(async () => {
	await ensureTestDatabase();
	inspector = newBoss();
	inspector.on('error', (error) => console.error(error));
	await inspector.start();
	await inspector.createQueue(QUEUE);
	await inspector.deleteAllJobs(QUEUE);
});

afterAll(async () => {
	await inspector.deleteQueue(QUEUE);
	await inspector.stop({ graceful: false });
});

describe('stopWorker', () => {
	it('releases a job that outlives the stop timeout, and aborts its signal', async () => {
		const worker = newBoss();
		worker.on('error', (error) => console.error(error));
		await worker.start();

		let started!: () => void;
		const running = new Promise<void>((resolve) => (started = resolve));
		let signal: AbortSignal | undefined;
		await worker.work(QUEUE, { pollingIntervalSeconds: 0.5 }, async ([job]) => {
			signal = job.signal;
			started();
			// Ignores the signal: a handler mid-way through a slow step.
			await new Promise((resolve) => setTimeout(resolve, 10_000));
		});
		const id = await inspector.send(QUEUE, {}, { retryLimit: 2, retryDelay: 0 });
		await running;

		const began = Date.now();
		await stopWorker(worker, 1000);
		expect(Date.now() - began).toBeLessThan(5000);

		expect(signal?.aborted).toBe(true);
		const job = await inspector.getJobById(QUEUE, id!);
		expect(job?.state).toBe('retry');
	});
});
