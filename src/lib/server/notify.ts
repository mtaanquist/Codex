import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from './auth';
import { notifications, reviewComments, reviewers, stories, users } from './db/schema';
import { normaliseNotifications } from './preferences';
import { queueNotificationDigest, queueReviewerDigest } from './jobs';
import type { NotificationItem, NotificationKind, NotificationPayload } from '$lib/notifications';

// The fan-out behind every notification: one event in, per-user rows out,
// each stamped with the channels that user's preference matrix allows. The
// email side rides the worker's batched digest; nothing sends from here.

const DETAIL_MAX = 120;

// A comment body cut down to a one-line teaser for the bell and the digest.
export function detailSnippet(body: string): string {
	const line = body.replace(/\s+/g, ' ').trim();
	return line.length > DETAIL_MAX ? `${line.slice(0, DETAIL_MAX)}...` : line;
}

export async function notifyUsers(
	db: Database,
	userIds: string[],
	kind: NotificationKind,
	payload: NotificationPayload
): Promise<void> {
	const ids = [...new Set(userIds)];
	if (ids.length === 0) return;
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
	for (const userId of digestUsers) await queueNotificationDigest(userId);
}

export async function notifyAdmins(
	db: Database,
	kind: NotificationKind,
	payload: NotificationPayload
): Promise<void> {
	const admins = await db.select({ id: users.id }).from(users).where(eq(users.role, 'admin'));
	await notifyUsers(
		db,
		admins.map((row) => row.id),
		kind,
		payload
	);
}

// A guest did something on the author's story: comment, reply, or
// suggestion. One notification to the owner, linking the feedback page.
export async function notifyReviewActivity(
	db: Database,
	storyId: string,
	reviewerName: string,
	what: 'commented' | 'replied' | 'suggested an edit',
	body?: string
): Promise<void> {
	const [story] = await db
		.select({ ownerId: stories.ownerId, title: stories.title, slug: stories.slug })
		.from(stories)
		.where(eq(stories.id, storyId));
	if (!story) return;
	await notifyUsers(db, [story.ownerId], 'review_activity', {
		title: `${reviewerName} ${what} on "${story.title}"`,
		detail: body ? detailSnippet(body) : undefined,
		href: `/stories/${story.slug}/review`
	});
}

// Review replies fan out to everyone who commented in the thread except the
// author: reviewers with accounts get the bell and their own digest, guests
// with an email get the reviewer digest, guests without stay silent.
export async function notifyThreadReviewers(
	db: Database,
	threadId: string,
	payload: NotificationPayload
): Promise<void> {
	const rows = await db
		.selectDistinct({
			reviewerId: reviewers.id,
			userId: reviewers.userId,
			email: reviewers.email,
			optedOut: reviewers.emailOptOutAt
		})
		.from(reviewComments)
		.innerJoin(reviewers, eq(reviewComments.authorReviewerId, reviewers.id))
		.where(eq(reviewComments.threadId, threadId));
	const accountIds = rows.filter((row) => row.userId).map((row) => row.userId!);
	await notifyUsers(db, accountIds, 'review_reply', payload);
	for (const row of rows) {
		if (!row.userId && row.email && !row.optedOut) await queueReviewerDigest(row.reviewerId);
	}
}

const BELL_LIMIT = 20;

// What the bell shows: the recent in-app rows and the unread count.
export async function listNotifications(
	db: Database,
	userId: string
): Promise<{ unread: number; items: NotificationItem[] }> {
	const rows = await db
		.select()
		.from(notifications)
		.where(and(eq(notifications.userId, userId), eq(notifications.inApp, true)))
		.orderBy(desc(notifications.createdAt))
		.limit(BELL_LIMIT);
	const [count] = await db
		.select({ unread: sql<number>`count(*)::int` })
		.from(notifications)
		.where(
			and(
				eq(notifications.userId, userId),
				eq(notifications.inApp, true),
				isNull(notifications.readAt)
			)
		);
	return {
		unread: count?.unread ?? 0,
		items: rows.map((row) => ({
			id: row.id,
			kind: row.kind,
			title: row.payload.title,
			detail: row.payload.detail ?? null,
			href: row.payload.href ?? null,
			read: row.readAt !== null,
			createdAt: row.createdAt.toISOString()
		}))
	};
}

// Marks the given notifications read, or every unread one when ids is null.
// Scoped to the owner, so a stray id cannot touch someone else's rows.
export async function markNotificationsRead(
	db: Database,
	userId: string,
	ids: string[] | null
): Promise<void> {
	const scope = [eq(notifications.userId, userId), isNull(notifications.readAt)];
	if (ids !== null) {
		if (ids.length === 0) return;
		scope.push(inArray(notifications.id, ids));
	}
	await db
		.update(notifications)
		.set({ readAt: new Date() })
		.where(and(...scope));
}
