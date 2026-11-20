import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PgBoss } from 'pg-boss';
import {
	PURGE_ACCOUNTS_QUEUE,
	PURGE_REVIEW_RUNS_QUEUE,
	PURGE_SESSIONS_QUEUE,
	PURGE_UNIVERSES_QUEUE,
	RECONCILE_MENTIONS_QUEUE,
	SWEEP_DELETED_OBJECTS_QUEUE
} from '../../src/lib/server/queues';
import { registerSchedules, WORKER_SCHEDULES } from '../../src/worker/schedules';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

// What the worker is meant to run and how often. Written out again here on
// purpose: a sweep dropped from the table, or a cron changed by accident,
// fails this file.
const EXPECTED: Record<string, string> = {
	[PURGE_ACCOUNTS_QUEUE]: '30 * * * *',
	[PURGE_UNIVERSES_QUEUE]: '45 * * * *',
	[SWEEP_DELETED_OBJECTS_QUEUE]: '0 4 * * *',
	[PURGE_REVIEW_RUNS_QUEUE]: '15 4 * * *',
	[PURGE_SESSIONS_QUEUE]: '50 4 * * *',
	[RECONCILE_MENTIONS_QUEUE]: '*/5 * * * *'
};

let boss: PgBoss;

beforeAll(async () => {
	await ensureTestDatabase();
	// No timekeeper, so the schedules are stored but never fire here.
	boss = new PgBoss({ connectionString: TEST_DATABASE_URL, supervise: false, schedule: false });
	boss.on('error', (error) => console.error(error));
	await boss.start();
	for (const { queue } of WORKER_SCHEDULES) await boss.createQueue(queue);
});

afterAll(async () => {
	for (const { queue } of WORKER_SCHEDULES) await boss.unschedule(queue);
	await boss.stop({ graceful: false });
});

describe('worker schedules', () => {
	it('registers every sweep with pg-boss, in UTC, at its expected time', async () => {
		await registerSchedules(boss);
		const stored = (await boss.getSchedules()).filter((s) => s.name in EXPECTED);
		expect(Object.fromEntries(stored.map((s) => [s.name, s.cron]))).toEqual(EXPECTED);
		expect(new Set(stored.map((s) => s.timezone))).toEqual(new Set(['UTC']));
	});

	it('lists each queue once and nothing beyond the expected sweeps', () => {
		const queues = WORKER_SCHEDULES.map((s) => s.queue);
		expect(new Set(queues).size).toBe(queues.length);
		expect([...queues].sort()).toEqual(Object.keys(EXPECTED).sort());
	});
});
