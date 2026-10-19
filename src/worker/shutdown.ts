import type { PgBoss } from 'pg-boss';

// How long a stopping worker waits for running jobs to finish before pg-boss
// fails them into a retry and aborts their signal. It must end well inside the
// container's stop_grace_period (compose.yaml), or Docker's SIGKILL lands first
// and the jobs stay active until they expire, blocking a new run of the same
// singleton job. shutdown.test.ts holds the two together.
export const WORKER_STOP_TIMEOUT_MS = 45_000;

export function stopWorker(
	boss: Pick<PgBoss, 'stop'>,
	timeout = WORKER_STOP_TIMEOUT_MS
): Promise<void> {
	return boss.stop({ timeout });
}
