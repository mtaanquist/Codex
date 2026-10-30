import { sql } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { db } from '#lib/server/db';

// Shorter than the container healthcheck's own timeout, so the probe always
// gets an answer rather than being killed.
const PROBE_TIMEOUT_MS = 3_000;

// Liveness and readiness in one: the process is up if this runs, and the
// database is reachable if the probe query succeeds. 503 when it does not, or
// when it does not answer in time (an exhausted pool queues the probe), so a
// proxy or orchestrator can route around a broken instance.
export const GET: RequestHandler = async () => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			db.execute(sql`select 1`),
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error('probe timed out')), PROBE_TIMEOUT_MS);
			})
		]);
		return Response.json({ status: 'ok' });
	} catch {
		return Response.json({ status: 'error' }, { status: 503 });
	} finally {
		clearTimeout(timer);
	}
};
