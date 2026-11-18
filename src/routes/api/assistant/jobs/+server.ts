import { error, type RequestHandler } from '@sveltejs/kit';
import { listRunningAssistantJobs } from '#lib/server/jobs';

// The signed-in writer's Assistant jobs that are still queued or running, so a
// freshly loaded page can show them again. Progress is read per job from
// job-status, as for a job the page started itself.
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) error(401, 'Sign in to check your jobs.');
	return Response.json({ jobs: await listRunningAssistantJobs(locals.user.id) });
};
