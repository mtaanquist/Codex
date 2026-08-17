import { and, eq } from 'drizzle-orm';
import type { Database } from './auth.ts';
import { assistantReviewRuns, type ReviewRunState } from './db/schema.ts';

// Progress storage for the background review job. The job writes its state as
// it advances (one row per pg-boss job id), so the status endpoint can report
// where it is and a retry of the same job after a worker restart can skip the
// scenes already handled.

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
