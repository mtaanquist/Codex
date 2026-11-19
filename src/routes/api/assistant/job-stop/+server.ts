import { error, type RequestHandler } from '@sveltejs/kit';
import { stopRunningAssistantJob } from '#lib/server/jobs';

// Stops one of the writer's queued or running Assistant jobs, from the Stop
// button on its activity card. Only the writer who started a job can stop it.
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) error(401, 'Sign in to stop a job.');
	const body = (await request.json().catch(() => null)) as { id?: unknown } | null;
	if (typeof body?.id !== 'string' || !body.id) error(400, 'A job id is required.');
	const stopped = await stopRunningAssistantJob(locals.user.id, body.id);
	if (stopped === null) error(503, 'Could not stop it. Try again in a moment.');
	if (!stopped) error(404, 'This job has already finished.');
	return Response.json({ ok: true });
};
