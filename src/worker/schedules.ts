import type { PgBoss } from 'pg-boss';
import {
	PURGE_ACCOUNTS_QUEUE,
	PURGE_REVIEW_RUNS_QUEUE,
	PURGE_SESSIONS_QUEUE,
	PURGE_UNIVERSES_QUEUE,
	RECONCILE_MENTIONS_QUEUE,
	SWEEP_DELETED_OBJECTS_QUEUE
} from '../lib/server/queues.ts';

// The fixed sweeps the worker registers at startup, all in UTC. The backup
// schedule is not here: it depends on saved settings and is set in index.ts.
export const WORKER_SCHEDULES: readonly { queue: string; cron: string }[] = [
	// Accounts past their grace window go hourly.
	{ queue: PURGE_ACCOUNTS_QUEUE, cron: '30 * * * *' },
	// The universe trash sweep, offset from the account one.
	{ queue: PURGE_UNIVERSES_QUEUE, cron: '45 * * * *' },
	{ queue: SWEEP_DELETED_OBJECTS_QUEUE, cron: '0 4 * * *' },
	// Old review progress goes once a day; nothing is time critical about it.
	{ queue: PURGE_REVIEW_RUNS_QUEUE, cron: '15 4 * * *' },
	// Expired and long-revoked sessions go once a day.
	{ queue: PURGE_SESSIONS_QUEUE, cron: '50 4 * * *' },
	// Stale mention indexes are swept every five minutes, so a dropped rebuild
	// self-heals within minutes instead of waiting for the next save.
	{ queue: RECONCILE_MENTIONS_QUEUE, cron: '*/5 * * * *' }
];

export async function registerSchedules(boss: Pick<PgBoss, 'schedule'>): Promise<void> {
	for (const { queue, cron } of WORKER_SCHEDULES) {
		await boss.schedule(queue, cron, {}, { tz: 'UTC' });
	}
}
