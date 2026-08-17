import { error, json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { getAssistantJobState } from '$lib/server/jobs';
import { loadReviewRun } from '$lib/server/review-runs';

// Where the activity center and the review modal poll a queued Assistant job
// (review or summaries) to completion. Job ids are unguessable, and the reply
// carries only the job's progress, so a signed-in user may read any id they
// hold; the recorded progress of a review is scoped to the user who started it.
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) error(401, 'Sign in to check a job.');
	const kind = url.searchParams.get('kind');
	const id = url.searchParams.get('id');
	if ((kind !== 'review' && kind !== 'summaries') || !id) {
		error(400, 'A job kind and id are required.');
	}
	const state = await getAssistantJobState(kind, id);
	if (kind !== 'review') return json({ state });

	const run = await loadReviewRun(db, id, locals.user.id);
	if (!run) return json({ state });
	return json({
		state,
		phase: run.phase,
		completed: run.completed.length,
		total: run.total,
		currentSceneTitle: run.currentSceneTitle ?? null,
		reviewed: run.reviewed,
		failed: run.failed,
		notes: run.notes,
		failures: run.failures,
		summariesRefreshed: run.summariesRefreshed ?? false,
		aborted: run.aborted ?? false,
		capped: run.capped ?? false,
		spentUsd: run.spentUsd ?? null
	});
};
