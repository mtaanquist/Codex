import { and, desc, eq, lt, sql } from 'drizzle-orm';
import type { Database } from './auth.ts';
import { assistantReviewRuns, type ReviewRunState } from './db/schema.ts';
import { parseCategories, type PatternScope, type ReviewCategory } from '../review-shape.ts';

// Progress storage for the background review job. The job writes its state as
// it advances (one row per pg-boss job id), so the status endpoint can report
// where it is and a retry of the same job after a worker restart can skip the
// scenes already handled.

// What a run was over: the mode, the target and, for a copyedit, the
// categories it checks (in canonical order; "general" is the sparing pass with
// none). The queue holds one unfinished job per key, so a copyedit for other
// categories is its own job rather than refused as a repeat. Stored on the run
// state so a later job over the same scope can pick up where a capped run
// stopped (see adoptCappedRun) - the writer starts that one from the same
// button, so it arrives with a job id the earlier run never saw.
type ScopeInput = {
	storyId?: string;
	universeId?: string;
	chapterId?: string;
	categories?: ReviewCategory[];
	mode?: 'full' | 'continuity';
	patterns?: PatternScope;
};

function scopeTarget(input: ScopeInput): string {
	return input.universeId
		? `universe:${input.universeId}`
		: input.chapterId
			? `${input.storyId}:${input.chapterId}`
			: `${input.storyId}`;
}

export function reviewScopeKey(input: ScopeInput): string {
	const target = scopeTarget(input);
	if (input.mode === 'continuity') return `continuity:${target}`;
	const categories = parseCategories(input.categories);
	const base = `full:${target}:${categories.length ? categories.join('+') : 'general'}`;
	// A pattern pass is part of what the run does, so it is its own scope; a run
	// without one keeps the key it always had.
	return input.patterns ? `${base}:patterns-${input.patterns}` : base;
}

// LEGACY, remove with the legacy queues (#1041): the key a copyedit had before
// its categories were part of it, so a run capped before the upgrade can still
// be continued (see adoptCappedRun). A continuity key did not change.
export function legacyReviewScopeKey(input: ScopeInput): string | null {
	return input.mode === 'continuity' ? null : `full:${scopeTarget(input)}`;
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
// forward. Only the newest run over the scope counts, and only if it was
// capped: a run that finished within its ceiling is done, and a fresh review of
// the same story must really review every scene again, even when an older
// capped run is still on record.
//
// A continuation of a capped run saves its own row (not capped) as soon as it
// starts, so it becomes the newest. If it then never finished (it threw, which
// completes its job with the row part-way, or it was cancelled), its row holds
// the capped run's scenes plus its own, and that is what is carried forward.
//
// The counts come across, but not the ceiling: each run gets the whole budget
// again, which is what "run the review again to continue" promises.
//
// legacy: when nothing was run under the scope yet, a capped run saved under
// the old key (no categories in it) is continued, but only when its job is
// known to have checked these same categories. The old row does not record
// them, so they are read from the job; once the queue has forgotten the job the
// run starts over, since carrying it forward could report scenes as reviewed
// for categories nobody checked.
export async function adoptCappedRun(
	db: Database,
	opts: {
		userId: string;
		scope: string;
		legacy?: {
			scope: string;
			categories: ReviewCategory[];
			jobCategories: (jobId: string) => Promise<ReviewCategory[] | null>;
		};
	}
): Promise<ReviewRunState | null> {
	const row = await newestRun(db, opts.userId, opts.scope);
	if (row) return resumable(row.state) ? carryForward(row.state, opts.scope) : null;
	if (!opts.legacy) return null;
	const legacy = await newestRun(db, opts.userId, opts.legacy.scope);
	if (!legacy || !resumable(legacy.state)) return null;
	const checked = await opts.legacy.jobCategories(legacy.jobId);
	if (!checked || !sameCategories(checked, opts.legacy.categories)) return null;
	return carryForward(legacy.state, opts.scope);
}

async function newestRun(
	db: Database,
	userId: string,
	scope: string
): Promise<{ jobId: string; state: ReviewRunState } | null> {
	const [row] = await db
		.select({ jobId: assistantReviewRuns.jobId, state: assistantReviewRuns.state })
		.from(assistantReviewRuns)
		.where(
			and(
				eq(assistantReviewRuns.userId, userId),
				sql`${assistantReviewRuns.state} ->> 'scope' = ${scope}`
			)
		)
		.orderBy(desc(assistantReviewRuns.updatedAt))
		.limit(1);
	return row ?? null;
}

// Capped, or a continuation of a capped run that stopped before it finished.
// A run that finished cleanly, or a fresh run that never carried anything
// forward, is not resumed.
function resumable(state: ReviewRunState): boolean {
	if (state.capped) return true;
	return !!state.carriedForward && (state.phase !== 'done' || !!state.aborted);
}

function sameCategories(a: ReviewCategory[], b: ReviewCategory[]): boolean {
	return parseCategories(a).join('+') === parseCategories(b).join('+');
}

function carryForward(state: ReviewRunState, scope: string): ReviewRunState {
	return {
		...emptyReviewRun(),
		scope,
		completed: state.completed,
		reviewed: state.reviewed,
		failed: state.failed,
		notes: state.notes,
		// Scene failures only: the earlier run's own messages (a cap it hit, a
		// price it lacked) say nothing about this one.
		failures: state.failures.filter((failure) => failure.sceneId),
		...(state.summariesRefreshed ? { summariesRefreshed: true } : {}),
		// The pattern pass's surveys, notes, and fixed scenes, so a continued run
		// neither pays for them again nor raises the same habits twice.
		...(state.patterns ? { patterns: state.patterns } : {}),
		capped: false,
		spentUsd: 0,
		carriedForward: true
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
