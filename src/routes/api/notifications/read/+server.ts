import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { markNotificationsRead } from '$lib/server/notify';

// Marks notifications read: {ids: [...]} for specific ones, {all: true}
// for everything unread.
export const POST: RequestHandler = async ({ request, locals }) => {
	const payload = (await request.json()) as { ids?: unknown; all?: unknown };
	if (payload.all === true) {
		await markNotificationsRead(db, locals.user!.id, null);
	} else if (Array.isArray(payload.ids) && payload.ids.every((id) => typeof id === 'string')) {
		await markNotificationsRead(db, locals.user!.id, payload.ids);
	} else {
		error(400, 'Send ids or all.');
	}
	return json({ ok: true });
};
