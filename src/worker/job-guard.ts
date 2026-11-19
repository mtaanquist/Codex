import type { PgBoss } from 'pg-boss';
import { errorFields, logEvent } from '../lib/server/log.ts';
import { WriterStopError } from '../lib/server/llm/providers/types.ts';

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

// The signal an Assistant job's requests run under. pg-boss aborts job.signal
// the same way whether the writer selected Stop (which cancels the job), the
// job expired, or the worker is shutting down. Only a Stop ends the job for
// good, so only it is passed on as a writer's stop (see WriterStopError); after
// the others the job runs again with what it spent, and the provider must keep
// counting a cut-short reply at its output cap. pg-boss also aborts job.signal
// when a job completes normally, so call release once the work has returned:
// nothing reads the signal then, and the job lookup would be wasted.
export function jobRunSignal(
	boss: Pick<PgBoss, 'getJobById'>,
	queue: string,
	job: Pick<RunningJob, 'id' | 'signal'>
): { signal: AbortSignal; release: () => void } {
	const controller = new AbortController();
	const pass = async () => {
		let cancelled = false;
		try {
			cancelled = (await boss.getJobById(queue, job.id))?.state === 'cancelled';
		} catch (error) {
			logEvent('error', 'job.state_failed', { queue, jobId: job.id, ...errorFields(error) });
		}
		controller.abort(cancelled ? new WriterStopError() : job.signal.reason);
	};
	const onAbort = () => void pass();
	if (job.signal.aborted) void pass();
	else job.signal.addEventListener('abort', onAbort, { once: true });
	return {
		signal: controller.signal,
		release: () => job.signal.removeEventListener('abort', onAbort)
	};
}

// Runs one piece of an Assistant job's work under jobRunSignal, released when
// the work returns or throws.
export async function withJobRunSignal<T>(
	boss: Pick<PgBoss, 'getJobById'>,
	job: Pick<RunningJob, 'id' | 'signal'> & { name: string },
	run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
	const { signal, release } = jobRunSignal(boss, job.name, job);
	try {
		return await run(signal);
	} finally {
		release();
	}
}
