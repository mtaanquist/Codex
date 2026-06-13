import { error, json, type RequestHandler } from '@sveltejs/kit';
import { getAssistantJobState } from '$lib/server/jobs';

// Where the activity center polls a queued Assistant job (review or summaries)
// to completion. Job ids are unguessable, and the reply carries only the job's
// progress, so a signed-in user may read any id they hold.
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) error(401, 'Sign in to check a job.');
	const kind = url.searchParams.get('kind');
	const id = url.searchParams.get('id');
	if ((kind !== 'review' && kind !== 'summaries') || !id) {
		error(400, 'A job kind and id are required.');
	}
	return json({ state: await getAssistantJobState(kind, id) });
};
