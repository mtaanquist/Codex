import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Database } from './auth';
import {
	reviewComments,
	reviewInvitations,
	reviewers,
	reviewThreads,
	revisions,
	scenes,
	stories,
	users
} from './db/schema';
import { hashToken } from './tokens';
import { signToken, verifyToken } from './crypto';

// Guest review, stage one: invitations, guest identity, and threaded
// comments. An author invites someone to one story by magic link; the guest
// reads the manuscript and leaves comments anchored to text ranges, and the
// author replies and resolves. Suggestions come in a later step. Only the
// link token's hash is stored, and revoking an invitation cuts access while
// keeping the threads.

const MAX_COMMENT_LENGTH = 5000;
const REVIEWER_COOKIE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const REVIEWER_COOKIE = 'reviewer';

export async function createReviewInvitation(
	db: Database,
	input: { storyId: string; createdBy: string; email?: string; expiresAt?: Date | null }
): Promise<{ id: string; token: string }> {
	const token = randomBytes(32).toString('base64url');
	const [row] = await db
		.insert(reviewInvitations)
		.values({
			storyId: input.storyId,
			createdBy: input.createdBy,
			tokenHash: hashToken(token),
			email: input.email?.trim() || null,
			expiresAt: input.expiresAt ?? null
		})
		.returning({ id: reviewInvitations.id });
	return { id: row.id, token };
}

// The author's view: every invitation for the story with who has joined
// under it, newest first.
export async function listReviewInvitations(db: Database, storyId: string) {
	const invitations = await db
		.select()
		.from(reviewInvitations)
		.where(eq(reviewInvitations.storyId, storyId))
		.orderBy(desc(reviewInvitations.createdAt));
	if (invitations.length === 0) return [];
	const guestRows = await db
		.select({
			invitationId: reviewers.invitationId,
			displayName: reviewers.displayName,
			lastSeenAt: reviewers.lastSeenAt
		})
		.from(reviewers)
		.where(
			inArray(
				reviewers.invitationId,
				invitations.map((invitation) => invitation.id)
			)
		);
	return invitations.map((invitation) => ({
		...invitation,
		guests: guestRows.filter((guest) => guest.invitationId === invitation.id)
	}));
}

export async function revokeReviewInvitation(
	db: Database,
	userId: string,
	invitationId: string
): Promise<boolean> {
	const updated = await db
		.update(reviewInvitations)
		.set({ revokedAt: sql`now()` })
		.where(
			and(
				eq(reviewInvitations.id, invitationId),
				eq(reviewInvitations.createdBy, userId),
				isNull(reviewInvitations.revokedAt)
			)
		)
		.returning({ id: reviewInvitations.id });
	return updated.length > 0;
}

// Resolves a magic-link token to its invitation and story when it still
// grants access. Distinguishes a dead link from a stale one so the landing
// page can say which.
export async function invitationByToken(db: Database, token: string) {
	const [row] = await db
		.select({
			invitation: reviewInvitations,
			storyTitle: stories.title,
			storyOwnerId: stories.ownerId
		})
		.from(reviewInvitations)
		.innerJoin(stories, eq(reviewInvitations.storyId, stories.id))
		.where(eq(reviewInvitations.tokenHash, hashToken(token)));
	if (!row) return { status: 'unknown' as const };
	if (row.invitation.revokedAt) return { status: 'revoked' as const };
	if (row.invitation.expiresAt && row.invitation.expiresAt < new Date()) {
		return { status: 'expired' as const };
	}
	return { status: 'ok' as const, ...row };
}

// Finds or creates the reviewer identity for this invitation: a signed-in
// user reviews as themselves (one row per invitation), a guest gets a fresh
// row under the name they give.
export async function ensureReviewer(
	db: Database,
	invitationId: string,
	identity: { userId: string; displayName: string } | { displayName: string }
) {
	if ('userId' in identity) {
		const [existing] = await db
			.select()
			.from(reviewers)
			.where(and(eq(reviewers.invitationId, invitationId), eq(reviewers.userId, identity.userId)));
		if (existing) return existing;
		const [row] = await db
			.insert(reviewers)
			.values({
				invitationId,
				userId: identity.userId,
				displayName: identity.displayName
			})
			.returning();
		return row;
	}
	const displayName = identity.displayName.trim();
	if (!displayName) return null;
	const [row] = await db.insert(reviewers).values({ invitationId, displayName }).returning();
	return row;
}

// The signed cookie that ties a browser to its reviewer row across visits.
export function issueReviewerToken(reviewerId: string): string {
	return signToken(`reviewer.${reviewerId}.${Date.now() + REVIEWER_COOKIE_TTL_MS}`);
}

export function readReviewerToken(token: string | undefined): string | null {
	if (!token) return null;
	const payload = verifyToken(token);
	if (!payload) return null;
	const [purpose, reviewerId, expiresAt] = payload.split('.');
	if (purpose !== 'reviewer' || !reviewerId) return null;
	if (!Number.isFinite(Number(expiresAt)) || Date.now() > Number(expiresAt)) return null;
	return reviewerId;
}

// The guard for everything a guest does: the reviewer must exist and their
// invitation must still grant access to this story. Touches last_seen_at.
export async function reviewerAccess(db: Database, reviewerId: string, storyId: string) {
	const [row] = await db
		.select({ reviewer: reviewers, invitation: reviewInvitations })
		.from(reviewers)
		.innerJoin(reviewInvitations, eq(reviewers.invitationId, reviewInvitations.id))
		.where(
			and(
				eq(reviewers.id, reviewerId),
				eq(reviewInvitations.storyId, storyId),
				isNull(reviewInvitations.revokedAt),
				or(isNull(reviewInvitations.expiresAt), gt(reviewInvitations.expiresAt, sql`now()`))
			)
		);
	if (!row) return null;
	await db
		.update(reviewers)
		.set({ lastSeenAt: sql`now()` })
		.where(eq(reviewers.id, reviewerId));
	return row;
}

// The base revision a new thread pins its anchor to: the latest scene
// revision when it matches the current text, else a fresh snapshot, so the
// anchor always has the exact text it was placed against.
async function ensureBaseRevision(db: Database, sceneId: string, bodyMd: string): Promise<string> {
	const [latest] = await db
		.select({ id: revisions.id, bodyMd: revisions.bodyMd })
		.from(revisions)
		.where(and(eq(revisions.entityType, 'scene'), eq(revisions.entityId, sceneId)))
		.orderBy(desc(revisions.createdAt))
		.limit(1);
	if (latest && latest.bodyMd === bodyMd) return latest.id;
	const [created] = await db
		.insert(revisions)
		.values({ entityType: 'scene', entityId: sceneId, bodyMd, reason: 'autosave' })
		.returning({ id: revisions.id });
	return created.id;
}

export type ThreadAuthor = { userId: string } | { reviewerId: string };

function commentAuthorColumns(author: ThreadAuthor) {
	return 'userId' in author
		? { authorUserId: author.userId, authorReviewerId: null }
		: { authorUserId: null, authorReviewerId: author.reviewerId };
}

// Opens a thread with its first comment. A null anchor is a whole-scene
// comment; a range must be a real selection inside the current text.
export async function createThread(
	db: Database,
	input: {
		storyId: string;
		sceneId: string;
		anchor: { start: number; end: number } | null;
		author: ThreadAuthor;
		body: string;
	}
): Promise<{ ok: true; threadId: string } | { ok: false; reason: string }> {
	const body = input.body.trim();
	if (!body) return { ok: false, reason: 'Write a comment first.' };
	if (body.length > MAX_COMMENT_LENGTH) {
		return { ok: false, reason: 'That comment is too long.' };
	}
	const [scene] = await db
		.select({ id: scenes.id, bodyMd: scenes.bodyMd })
		.from(scenes)
		.where(and(eq(scenes.id, input.sceneId), eq(scenes.storyId, input.storyId)));
	if (!scene) return { ok: false, reason: 'That scene does not exist.' };
	if (
		input.anchor &&
		(input.anchor.start < 0 ||
			input.anchor.end > scene.bodyMd.length ||
			input.anchor.start >= input.anchor.end)
	) {
		return { ok: false, reason: 'That selection no longer matches the text.' };
	}

	const baseRevisionId = input.anchor ? await ensureBaseRevision(db, scene.id, scene.bodyMd) : null;
	const threadId = await db.transaction(async (tx) => {
		const [thread] = await tx
			.insert(reviewThreads)
			.values({
				storyId: input.storyId,
				sceneId: input.sceneId,
				anchorStart: input.anchor?.start ?? null,
				anchorEnd: input.anchor?.end ?? null,
				baseRevisionId
			})
			.returning({ id: reviewThreads.id });
		await tx.insert(reviewComments).values({
			threadId: thread.id,
			...commentAuthorColumns(input.author),
			bodyMd: body
		});
		return thread.id;
	});
	return { ok: true, threadId };
}

// Replies to an existing thread. The caller has already established the
// author's right to this story; the thread only needs to belong to it.
export async function addComment(
	db: Database,
	input: { storyId: string; threadId: string; author: ThreadAuthor; body: string }
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const body = input.body.trim();
	if (!body) return { ok: false, reason: 'Write a comment first.' };
	if (body.length > MAX_COMMENT_LENGTH) {
		return { ok: false, reason: 'That comment is too long.' };
	}
	const [thread] = await db
		.select({ id: reviewThreads.id })
		.from(reviewThreads)
		.where(and(eq(reviewThreads.id, input.threadId), eq(reviewThreads.storyId, input.storyId)));
	if (!thread) return { ok: false, reason: 'That thread does not exist.' };
	await db.insert(reviewComments).values({
		threadId: thread.id,
		...commentAuthorColumns(input.author),
		bodyMd: body
	});
	return { ok: true };
}

// Only the story's owner resolves or reopens a thread.
export async function setThreadResolved(
	db: Database,
	userId: string,
	threadId: string,
	resolved: boolean
): Promise<boolean> {
	const updated = await db
		.update(reviewThreads)
		.set(
			resolved
				? { resolvedAt: sql`now()`, resolvedByUserId: userId }
				: { resolvedAt: null, resolvedByUserId: null }
		)
		.where(
			and(
				eq(reviewThreads.id, threadId),
				inArray(
					reviewThreads.storyId,
					db.select({ id: stories.id }).from(stories).where(eq(stories.ownerId, userId))
				)
			)
		)
		.returning({ id: reviewThreads.id });
	return updated.length > 0;
}

export type ThreadView = {
	id: string;
	sceneId: string;
	// The anchor mapped onto the current text; null for whole-scene comments
	// and for anchors that no longer fit (anchorLost says which).
	anchor: { start: number; end: number } | null;
	anchorLost: boolean;
	resolvedAt: Date | null;
	createdAt: Date;
	comments: {
		id: string;
		body: string;
		authorName: string;
		isOwner: boolean;
		createdAt: Date;
	}[];
};

// Threads for a set of scenes, with comments and attribution, anchors
// re-mapped against the current scene text by the caller-supplied mapper
// (kept injectable so the pure logic stays unit-tested in review-anchor).
export async function listThreads(
	db: Database,
	storyId: string,
	mapAnchor: (
		baseText: string,
		currentText: string,
		start: number,
		end: number
	) => { start: number; end: number } | null
): Promise<ThreadView[]> {
	const threadRows = await db
		.select({
			thread: reviewThreads,
			baseBody: revisions.bodyMd,
			currentBody: scenes.bodyMd
		})
		.from(reviewThreads)
		.innerJoin(scenes, eq(reviewThreads.sceneId, scenes.id))
		.leftJoin(revisions, eq(reviewThreads.baseRevisionId, revisions.id))
		.where(eq(reviewThreads.storyId, storyId))
		.orderBy(asc(reviewThreads.createdAt));
	if (threadRows.length === 0) return [];

	const commentRows = await db
		.select({
			comment: reviewComments,
			reviewerName: reviewers.displayName,
			userName: users.displayName
		})
		.from(reviewComments)
		.leftJoin(reviewers, eq(reviewComments.authorReviewerId, reviewers.id))
		.leftJoin(users, eq(reviewComments.authorUserId, users.id))
		.where(
			inArray(
				reviewComments.threadId,
				threadRows.map((row) => row.thread.id)
			)
		)
		.orderBy(asc(reviewComments.createdAt));

	return threadRows.map((row) => {
		let anchor: { start: number; end: number } | null = null;
		let anchorLost = false;
		if (row.thread.anchorStart !== null && row.thread.anchorEnd !== null) {
			anchor = row.baseBody
				? mapAnchor(row.baseBody, row.currentBody, row.thread.anchorStart, row.thread.anchorEnd)
				: null;
			anchorLost = anchor === null;
		}
		return {
			id: row.thread.id,
			sceneId: row.thread.sceneId,
			anchor,
			anchorLost,
			resolvedAt: row.thread.resolvedAt,
			createdAt: row.thread.createdAt,
			comments: commentRows
				.filter((commentRow) => commentRow.comment.threadId === row.thread.id)
				.map((commentRow) => ({
					id: commentRow.comment.id,
					body: commentRow.comment.bodyMd,
					authorName: commentRow.comment.authorUserId
						? (commentRow.userName ?? 'Author')
						: (commentRow.reviewerName ?? 'Reviewer'),
					isOwner: commentRow.comment.authorUserId !== null,
					createdAt: commentRow.comment.createdAt
				}))
		};
	});
}
