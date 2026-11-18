import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PgBoss } from 'pg-boss';
import { ASSISTANT_ENRICH_QUEUE_OPTIONS } from '../../src/lib/server/queues';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

// The enrich queue relies on its policy, not the singletonKey alone, to turn a
// repeat request into the job already queued or running (the 409 the client
// shows). A test queue with the same options stands in for it.
const QUEUE = 'assistant-queue-policy-test';
let boss: PgBoss;

beforeAll(async () => {
	await ensureTestDatabase();
	boss = new PgBoss({ connectionString: TEST_DATABASE_URL, supervise: false, schedule: false });
	boss.on('error', (error) => console.error(error));
	await boss.start();
	await boss.deleteQueue(QUEUE);
	await boss.createQueue(QUEUE, ASSISTANT_ENRICH_QUEUE_OPTIONS);
});

afterAll(async () => {
	await boss.deleteQueue(QUEUE);
	await boss.stop({ graceful: false });
});

describe('assistant enrich queue policy', () => {
	it('holds one unfinished job per key, and takes a new one once it is done', async () => {
		const first = await boss.send(QUEUE, {}, { singletonKey: 'u1' });
		expect(first).toBeTruthy();
		expect(await boss.send(QUEUE, {}, { singletonKey: 'u1' })).toBeNull();
		expect(await boss.send(QUEUE, {}, { singletonKey: 'arc:c1' })).toBeTruthy();

		// Running counts as unfinished too.
		const running = await boss.fetch(QUEUE, { batchSize: 2 });
		expect(running).toHaveLength(2);
		expect(await boss.send(QUEUE, {}, { singletonKey: 'u1' })).toBeNull();
		await boss.complete(
			QUEUE,
			running.map((j) => j.id)
		);
		expect(await boss.send(QUEUE, {}, { singletonKey: 'u1' })).toBeTruthy();
	});
});
