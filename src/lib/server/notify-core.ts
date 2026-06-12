import { inArray } from 'drizzle-orm';
import type { Database } from './auth.ts';
import { notifications, users } from './db/schema.ts';
import { normaliseNotifications } from './preferences.ts';
import type { NotificationKind, NotificationPayload } from '$lib/notifications';

// The jobs-free core of the notification fan-out: insert one row per user,
// stamped with the channels that user's preference matrix allows, and return
// the user ids that want an email so the caller can queue their digest. Kept
// apart from notify.ts because notify.ts imports jobs.ts (which reads $env) and
// so cannot be imported by the worker; the worker calls this directly and
// queues digests through its own pg-boss handle.
export async function insertNotifications(
	db: Database,
	userIds: string[],
	kind: NotificationKind,
	payload: NotificationPayload
): Promise<string[]> {
	const ids = [...new Set(userIds)];
	if (ids.length === 0) return [];
	const rows = await db
		.select({ id: users.id, preferences: users.preferences })
		.from(users)
		.where(inArray(users.id, ids));
	const inserts: (typeof notifications.$inferInsert)[] = [];
	const digestUsers: string[] = [];
	for (const row of rows) {
		const channels = normaliseNotifications(
			(row.preferences as Record<string, unknown>).notifications
		)[kind];
		if (!channels.inApp && !channels.email) continue;
		inserts.push({
			userId: row.id,
			kind,
			payload,
			inApp: channels.inApp,
			emailWanted: channels.email
		});
		if (channels.email) digestUsers.push(row.id);
	}
	if (inserts.length > 0) await db.insert(notifications).values(inserts);
	return digestUsers;
}
