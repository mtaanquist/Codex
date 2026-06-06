import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm';
import type { Database } from './auth';
import {
	notifications,
	reviewComments,
	reviewers,
	reviewInvitations,
	reviewThreads,
	stories,
	users
} from './db/schema.ts';
import { signToken, verifyToken } from './crypto.ts';
import type { EmailMessage } from './email.ts';
import { teaser } from '../notifications.ts';

// The email half of notifications, run from the worker: a scheduled digest
// gathers everything unsent for one recipient and composes one email. Runs
// in the worker, so relative value imports carry explicit .ts extensions
// and the origin for links arrives as a parameter.

export type Digest = { email: EmailMessage; ids: string[] };

export async function buildUserDigest(
	db: Database,
	userId: string,
	origin: string
): Promise<Digest | null> {
	const [user] = await db
		.select({ email: users.email, displayName: users.displayName })
		.from(users)
		.where(eq(users.id, userId));
	if (!user?.email) return null;
	const rows = await db
		.select()
		.from(notifications)
		.where(
			and(
				eq(notifications.userId, userId),
				eq(notifications.emailWanted, true),
				isNull(notifications.emailedAt)
			)
		)
		.orderBy(asc(notifications.createdAt));
	if (rows.length === 0) return null;

	const lines: string[] = [];
	for (const row of rows) {
		lines.push(`- ${row.payload.title}`);
		if (row.payload.detail) lines.push(`  "${row.payload.detail}"`);
		if (row.payload.href) lines.push(`  ${origin}${row.payload.href}`);
	}
	const subject =
		rows.length === 1 ? rows[0].payload.title : `${rows.length} updates on your Codex work`;
	const text = [
		`Hi ${user.displayName},`,
		'',
		rows.length === 1
			? 'While you were away:'
			: `${rows.length} things happened while you were away:`,
		'',
		...lines,
		'',
		'You can choose which updates reach you by email on your account page.'
	].join('\n');
	return { email: { to: user.email, subject, text }, ids: rows.map((row) => row.id) };
}

export async function markEmailed(db: Database, ids: string[]): Promise<void> {
	if (ids.length === 0) return;
	await db
		.update(notifications)
		.set({ emailedAt: new Date() })
		.where(inArray(notifications.id, ids));
}

const OPT_OUT_PREFIX = 'reviewer-optout:';

export function reviewerOptOutToken(reviewerId: string): string {
	return signToken(`${OPT_OUT_PREFIX}${reviewerId}`);
}

// Consumes an opt-out link; returns whether it pointed at a real reviewer.
export async function applyReviewerOptOut(db: Database, token: string): Promise<boolean> {
	const payload = verifyToken(token);
	if (!payload?.startsWith(OPT_OUT_PREFIX)) return false;
	const reviewerId = payload.slice(OPT_OUT_PREFIX.length);
	const updated = await db
		.update(reviewers)
		.set({ emailOptOutAt: new Date() })
		.where(eq(reviewers.id, reviewerId))
		.returning({ id: reviewers.id });
	return updated.length > 0;
}

export type ReviewerDigest = { email: EmailMessage; reviewerId: string; upTo: Date };

// Author replies for a guest reviewer (email, no account): everything the
// story's owner wrote in threads this reviewer commented in since the last
// digest. The review page is only reachable through the reviewer's own
// link, which is stored hash-only, so the email points at the link they
// already have rather than carrying one.
export async function buildReviewerDigest(
	db: Database,
	reviewerId: string,
	origin: string
): Promise<ReviewerDigest | null> {
	const [reviewer] = await db.select().from(reviewers).where(eq(reviewers.id, reviewerId));
	if (!reviewer?.email || reviewer.userId || reviewer.emailOptOutAt) return null;

	const [invitation] = await db
		.select({ storyId: reviewInvitations.storyId, title: stories.title })
		.from(reviewInvitations)
		.innerJoin(stories, eq(reviewInvitations.storyId, stories.id))
		.where(eq(reviewInvitations.id, reviewer.invitationId));
	if (!invitation) return null;

	const since = reviewer.lastNotifiedAt ?? reviewer.createdAt;
	const replies = await db
		.select({
			body: reviewComments.bodyMd,
			createdAt: reviewComments.createdAt,
			authorName: users.displayName
		})
		.from(reviewComments)
		.innerJoin(reviewThreads, eq(reviewComments.threadId, reviewThreads.id))
		.innerJoin(users, eq(reviewComments.authorUserId, users.id))
		.where(
			and(
				eq(reviewThreads.storyId, invitation.storyId),
				gt(reviewComments.createdAt, since),
				inArray(
					reviewComments.threadId,
					db
						.select({ id: reviewComments.threadId })
						.from(reviewComments)
						.where(eq(reviewComments.authorReviewerId, reviewerId))
				)
			)
		)
		.orderBy(asc(reviewComments.createdAt));
	if (replies.length === 0) return null;

	const lines = replies.map((reply) => `- ${reply.authorName}: "${teaser(reply.body)}"`);
	const subject =
		replies.length === 1
			? `${replies[0].authorName} replied on "${invitation.title}"`
			: `${replies.length} replies on "${invitation.title}"`;
	const text = [
		`Hi ${reviewer.displayName},`,
		'',
		`The author replied to your comments on "${invitation.title}":`,
		'',
		...lines,
		'',
		'Open your review link to read and answer them.',
		'',
		`No more emails about this review: ${origin}/review-email-opt-out?token=${reviewerOptOutToken(reviewerId)}`
	].join('\n');
	return {
		email: { to: reviewer.email, subject, text },
		reviewerId,
		upTo: replies[replies.length - 1].createdAt
	};
}

export async function markReviewerNotified(
	db: Database,
	reviewerId: string,
	upTo: Date
): Promise<void> {
	// upTo is the last digested comment's timestamp truncated to JS
	// milliseconds, while Postgres keeps microseconds; one millisecond up
	// keeps that comment out of the next digest.
	await db
		.update(reviewers)
		.set({ lastNotifiedAt: new Date(upTo.getTime() + 1) })
		.where(eq(reviewers.id, reviewerId));
}
