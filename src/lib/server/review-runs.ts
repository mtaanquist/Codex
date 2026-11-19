import { and, desc, eq, lt, sql } from 'drizzle-orm';
import type { Database } from './auth.ts';
import { assistantReviewRuns, scenes, type ReviewRunState } from './db/schema.ts';
import { parseCategories, type ReviewCategory } from '../review-shape.ts';

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
	return `full:${target}:${categories.length ? categories.join('+') : 'general'}`;
}

// LEGACY, remove with the legacy queues (#1041): the key a copyedit had before
// its categories were part of it, so a run capped before the upgrade can still
// be continued (see adoptCappedRun). A continuity key did not change.
export function legacyReviewScopeKey(input: ScopeInput): string | null {
	return input.mode === 'continuity' ? null : `full:${scopeTarget(input)}`;
}

// The earlier progress of a review could not be read. The review does not
// start over in its place (that would bill every scene again); the attempt
// fails so pg-boss can retry it.
export class ReviewRunLoadError extends Error {
	constructor(cause: unknown) {
		super('Could not read the earlier progress of this review. Try again in a moment.', { cause });
		this.name = 'ReviewRunLoadError';
	}
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
	if (row) return resumable(row.state) ? carryForward(db, row.state, opts.scope) : null;
	if (!opts.legacy) return null;
	const legacy = await newestRun(db, opts.userId, opts.legacy.scope);
	if (!legacy || !resumable(legacy.state)) return null;
	const checked = await opts.legacy.jobCategories(legacy.jobId);
	if (!checked || !sameCategories(checked, opts.legacy.categories)) return null;
	return carryForward(db, legacy.state, opts.scope);
}

// The completed scenes edited since their pass read them. A scene with no
// recorded time (a row saved before they were kept) is taken as unedited.
async function editedSince(
	db: Database,
	state: ReviewRunState,
	ids: string[]
): Promise<Set<string>> {
	const stamps = state.reviewedAt ?? {};
	const stamped = ids.filter((id) => stamps[id]);
	if (stamped.length === 0) return new Set();
	// Compared in SQL at full precision: a JS Date keeps only milliseconds, so
	// an edit in the same millisecond as the stamp would read as before it.
	const rows = await db
		.select({ id: scenes.id })
		.from(scenes)
		.innerJoin(
			sql`unnest(array[${sql.join(
				stamped.map((id) => sql`${id}`),
				sql`, `
			)}]::uuid[], array[${sql.join(
				stamped.map((id) => sql`${stamps[id]}`),
				sql`, `
			)}]::timestamptz[]) as stamp(id, at)`,
			sql`stamp.id = ${scenes.id}`
		)
		.where(sql`${scenes.updatedAt} > stamp.at`);
	return new Set(rows.map((row) => row.id));
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

// A failed scene, and one the writer edited since its pass, leave the completed
// list so the continuation reviews them again; their counts and messages go
// with them. Notes the earlier pass left stay on the scene, and the next pass
// is shown them so it does not repeat them.
async function carryForward(
	db: Database,
	state: ReviewRunState,
	scope: string
): Promise<ReviewRunState> {
	const failedScenes = new Set(state.failedScenes ?? []);
	const kept = state.completed.filter((id) => !failedScenes.has(id));
	const edited = await editedSince(db, state, kept);
	const redo = new Set([...failedScenes, ...edited]);
	const reviewedAt = Object.fromEntries(
		Object.entries(state.reviewedAt ?? {}).filter(([id]) => !redo.has(id))
	);
	const notesByScene = Object.fromEntries(
		Object.entries(state.notesByScene ?? {}).filter(([id]) => !redo.has(id))
	);
	// The redone scenes' notes stay on them, but the new pass counts them again.
	const redoneNotes = [...redo].reduce((sum, id) => sum + (state.notesByScene?.[id] ?? 0), 0);
	return {
		...emptyReviewRun(),
		scope,
		completed: kept.filter((id) => !edited.has(id)),
		reviewed: Math.max(0, state.reviewed - edited.size),
		failed: Math.max(0, state.failed - failedScenes.size),
		notes: Math.max(0, state.notes - redoneNotes),
		// Scene failures only, for the scenes that stay done: the earlier run's
		// own messages (a cap it hit, a price it lacked) say nothing about this
		// one.
		failures: state.failures.filter((failure) => failure.sceneId && !redo.has(failure.sceneId)),
		...(Object.keys(reviewedAt).length ? { reviewedAt } : {}),
		...(Object.keys(notesByScene).length ? { notesByScene } : {}),
		...(state.summariesRefreshed ? { summariesRefreshed: true } : {}),
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
			set: { state: opts.state, updatedAt: sql`clock_timestamp()` }
		});
}
