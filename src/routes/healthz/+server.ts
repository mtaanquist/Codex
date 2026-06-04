import { json } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';

// Liveness and readiness in one: the process is up if this runs, and the
// database is reachable if the probe query succeeds. 503 when it does not, so a
// proxy or orchestrator can route around a broken instance.
export const GET: RequestHandler = async () => {
	try {
		await db.execute(sql`select 1`);
		return json({ status: 'ok' });
	} catch {
		return json({ status: 'error' }, { status: 503 });
	}
};
