import { and, desc, eq, lt, sql } from 'drizzle-orm';
import type { Database } from './auth.ts';
import { assistantReviewRuns, type ReviewRunState } from './db/schema.ts';

// Progress storage for the background review job. The job writes its state as
// it advances (one row per pg-boss job id), so the status endpoint can report
// where it is and a retry of the same job after a worker restart can skip the
// scenes already handled.

// What a run was over: the mode and the target, the same key the queue uses to
// hold one unfinished job per scope. Stored on the run state so a later job
// over the same scope can pick up where a capped run stopped (see
// adoptCappedRun) - the writer starts that one from the same button, so it
// arrives with a job id the earlier run never saw.
export function reviewScopeKey(input: {
	storyId?: string;
	universeId?: string;
	chapterId?: string;
	mode?: 'full' | 'continuity';
}): string {
	const target = input.universeId
		? `universe:${input.universeId}`
		: input.chapterId
			? `${input.storyId}:${input.chapterId}`
			: `${input.storyId}`;
	return `${input.mode ?? 'full'}:${target}`;
}

export function emptyReviewRun(): ReviewRunState {
	return {
		phase: 'summaries',
		total: 0,
		completed: [],
		reviewed: 0,
		failed: 0,
		notes: 0,
		failures: []
	};
}

export async function loadReviewRun(
	db: Database,
	jobId: string,
	userId?: string
): Promise<ReviewRunState | null> {
	const where = userId
		? and(eq(assistantReviewRuns.jobId, jobId), eq(assistantReviewRuns.userId, userId))
		: eq(assistantReviewRuns.jobId, jobId);
	const [row] = await db
		.select({ state: assistantReviewRuns.state })
		.from(assistantReviewRuns)
		.where(where);
	return row?.state ?? null;
}

// The work a capped run over this scope already did, for a later run to carry
// forward. Only a capped run is adopted: a run that finished within its ceiling
// is done, and a fresh full review of the same story must really review every
// scene again. The newest matching row wins.
//
// The counts come across, but not the ceiling: each run gets the whole budget
// again, which is what "run the review again to continue" promises.
export async function adoptCappedRun(
	db: Database,
	opts: { userId: string; scope: string }
): Promise<ReviewRunState | null> {
	const [row] = await db
		.select({ state: assistantReviewRuns.state })
		.from(assistantReviewRuns)
		.where(
			and(
				eq(assistantReviewRuns.userId, opts.userId),
				sql`${assistantReviewRuns.state} ->> 'scope' = ${opts.scope}`,
				sql`${assistantReviewRuns.state} ->> 'capped' = 'true'`
			)
		)
		.orderBy(desc(assistantReviewRuns.updatedAt))
		.limit(1);
	if (!row) return null;
	return {
		...emptyReviewRun(),
		scope: opts.scope,
		completed: row.state.completed,
		reviewed: row.state.reviewed,
		failed: row.state.failed,
		notes: row.state.notes,
		failures: row.state.failures,
		...(row.state.summariesRefreshed ? { summariesRefreshed: true } : {}),
		capped: false,
		spentUsd: 0
	};
}

// How long a finished run's progress is kept. The rows only serve the status
// endpoint and a resume, so old ones are swept rather than kept for good.
export const REVIEW_RUN_RETENTION_DAYS = 30;

export async function purgeReviewRuns(
	db: Database,
	retentionDays = REVIEW_RUN_RETENTION_DAYS
): Promise<number> {
	const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
	const deleted = await db
		.delete(assistantReviewRuns)
		.where(lt(assistantReviewRuns.updatedAt, cutoff))
		.returning({ jobId: assistantReviewRuns.jobId });
	return deleted.length;
}

export async function saveReviewRun(
	db: Database,
	opts: { jobId: string; userId: string; state: ReviewRunState }
): Promise<void> {
	await db
		.insert(assistantReviewRuns)
		.values({ jobId: opts.jobId, userId: opts.userId, state: opts.state })
		.onConflictDoUpdate({
			target: assistantReviewRuns.jobId,
			set: { state: opts.state, updatedAt: new Date() }
		});
}
