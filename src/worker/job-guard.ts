import type { PgBoss } from 'pg-boss';
import { errorFields, logEvent } from '../lib/server/log.ts';

type RunningJob = {
	id: string;
	startedOn: Date;
	retryCount: number;
	retryLimit: number;
	signal: AbortSignal;
};

// Whether this run of an Assistant job should tell the writer how it went. It
// should not when pg-boss is going to run the job again, or the retry would
// notify a second time: pg-boss aborts the signal when the job expires (or the
// worker shuts down) and fails it into a retry, and a lapsed heartbeat fails it
// into a retry without telling the handler at all. A retry keeps the job id but
// gets a new start time, which tells this run apart from one already running
// elsewhere. On the last attempt nothing follows, so the notice still goes.
export async function shouldNotifyWriter(
	boss: Pick<PgBoss, 'getJobById'>,
	queue: string,
	job: RunningJob
): Promise<boolean> {
	if (job.signal.aborted) return job.retryCount >= job.retryLimit;
	try {
		const current = await boss.getJobById(queue, job.id);
		if (!current) return true;
		if (current.startedOn?.getTime() !== job.startedOn.getTime()) return false;
		return current.state !== 'retry';
	} catch (error) {
		// Unknown: a possible second notice beats saying nothing at all.
		logEvent('error', 'job.state_failed', { queue, jobId: job.id, ...errorFields(error) });
		return true;
	}
}
