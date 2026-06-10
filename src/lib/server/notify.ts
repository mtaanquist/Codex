import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from './auth';
import {
	notifications,
	reviewComments,
	reviewers,
	reviewSuggestions,
	stories,
	users
} from './db/schema';
import { queueNotificationDigest, queueReviewerDigest } from './jobs';
import { insertNotifications } from './notify-core';
import {
	teaser,
	type NotificationItem,
	type NotificationKind,
	type NotificationPayload
} from '$lib/notifications';

// The fan-out behind every notification: one event in, per-user rows out,
// each stamped with the channels that user's preference matrix allows. The
// row insert lives in notify-core (worker-safe); this adds the digest queueing
// that the app side wants. Nothing sends from here - email rides the digest.

export async function notifyUsers(
	db: Database,
	userIds: string[],
	kind: NotificationKind,
	payload: NotificationPayload
): Promise<void> {
	const digestUsers = await insertNotifications(db, userIds, kind, payload);
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
		detail: body ? teaser(body) : undefined,
		href: `/stories/${story.slug}/review`
	});
}

// The shared fan-out for reviewer-facing replies: reviewers with accounts get
// the bell and their own digest, guests with an email get the reviewer
// digest, guests without stay silent.
type ReviewerRow = {
	reviewerId: string;
	userId: string | null;
	email: string | null;
	optedOut: Date | null;
};

async function fanOutToReviewers(
	db: Database,
	rows: ReviewerRow[],
	payload: NotificationPayload
): Promise<void> {
	const accountIds = rows.filter((row) => row.userId).map((row) => row.userId!);
	await notifyUsers(db, accountIds, 'review_reply', payload);
	for (const row of rows) {
		if (!row.userId && row.email && !row.optedOut) await queueReviewerDigest(row.reviewerId);
	}
}

// Review replies fan out to everyone who commented in the thread except the
// author.
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
	await fanOutToReviewers(db, rows, payload);
}

// A reply in a suggestion's discussion reaches the suggestion's own reviewer
// (who may not have commented in the fresh thread yet) and everyone who has,
// deduplicated so nobody hears twice.
export async function notifySuggestionDiscussion(
	db: Database,
	target: { suggestionId: string; threadId: string },
	payload: NotificationPayload
): Promise<void> {
	const fromSuggestion = await db
		.selectDistinct({
			reviewerId: reviewers.id,
			userId: reviewers.userId,
			email: reviewers.email,
			optedOut: reviewers.emailOptOutAt
		})
		.from(reviewSuggestions)
		.innerJoin(reviewers, eq(reviewSuggestions.reviewerId, reviewers.id))
		.where(eq(reviewSuggestions.id, target.suggestionId));
	const fromThread = await db
		.selectDistinct({
			reviewerId: reviewers.id,
			userId: reviewers.userId,
			email: reviewers.email,
			optedOut: reviewers.emailOptOutAt
		})
		.from(reviewComments)
		.innerJoin(reviewers, eq(reviewComments.authorReviewerId, reviewers.id))
		.where(eq(reviewComments.threadId, target.threadId));
	const unique = new Map([...fromSuggestion, ...fromThread].map((row) => [row.reviewerId, row]));
	await fanOutToReviewers(db, [...unique.values()], payload);
}

const BELL_LIMIT = 20;

// What the bell shows: the recent in-app rows and the unread count.
export async function listNotifications(
	db: Database,
	userId: string
): Promise<{ unread: number; items: NotificationItem[] }> {
	// The list and the unread count are independent; the bell loads on every
	// page, so run them together rather than back to back.
	const [rows, [count]] = await Promise.all([
		db
			.select()
			.from(notifications)
			.where(and(eq(notifications.userId, userId), eq(notifications.inApp, true)))
			.orderBy(desc(notifications.createdAt))
			.limit(BELL_LIMIT),
		db
			.select({ unread: sql<number>`count(*)::int` })
			.from(notifications)
			.where(
				and(
					eq(notifications.userId, userId),
					eq(notifications.inApp, true),
					isNull(notifications.readAt)
				)
			)
	]);
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
