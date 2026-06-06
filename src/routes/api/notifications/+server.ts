import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { listNotifications } from '$lib/server/notify';

// The topbar bell: recent notifications and the unread count.
export const GET: RequestHandler = async ({ locals }) => {
	return json(await listNotifications(db, locals.user!.id));
};
