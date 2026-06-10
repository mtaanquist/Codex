import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Database } from './auth';
import {
	reviewComments,
	reviewInvitations,
	reviewers,
	reviewSuggestions,
	reviewThreads,
	revisions,
	scenes,
	stories,
	users
} from './db/schema';
import { hashToken } from './tokens';
import { signToken, verifyToken } from './crypto';
import { recordRevision } from './revisions';
import { reanchorPoint, reanchorRange } from '../review-anchor';
import { wordCount } from '../word-count';
import { normaliseAssistantName } from './llm/prompts/persona';

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
	input: {
		storyId: string;
		createdBy: string;
		email?: string;
		canSuggest?: boolean;
		expiresAt?: Date | null;
	}
): Promise<{ id: string; token: string }> {
	const token = randomBytes(32).toString('base64url');
	const [row] = await db
		.insert(reviewInvitations)
		.values({
			storyId: input.storyId,
			createdBy: input.createdBy,
			tokenHash: hashToken(token),
			email: input.email?.trim() || null,
			canSuggest: input.canSuggest ?? true,
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
// A light shape check; the address only ever receives reply digests, so a
// bad one just means no email.
const REVIEWER_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function ensureReviewer(
	db: Database,
	invitationId: string,
	identity: { userId: string; displayName: string } | { displayName: string; email?: string }
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
	// Optional: a guest who leaves an email hears about author replies.
	const email = identity.email?.trim().toLowerCase() ?? '';
	const [row] = await db
		.insert(reviewers)
		.values({
			invitationId,
			displayName,
			email: REVIEWER_EMAIL_RE.test(email) ? email : null
		})
		.returning();
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

// A comment or suggestion is authored by the signed-in owner, a guest
// reviewer, or the Assistant. The Assistant carries no FK; its display name is
// resolved live from the owner's config (assistantDisplayName).
export type ThreadAuthor = { userId: string } | { reviewerId: string } | { assistant: true };

function commentAuthorColumns(author: ThreadAuthor) {
	if ('userId' in author) {
		return { authorUserId: author.userId, authorReviewerId: null, assistant: false };
	}
	if ('reviewerId' in author) {
		return { authorUserId: null, authorReviewerId: author.reviewerId, assistant: false };
	}
	return { authorUserId: null, authorReviewerId: null, assistant: true };
}

// The Assistant's name to show on its comments and suggestions: the owner's
// chosen assistant name, resolved at read time so a rename relabels everything
// on the fly, falling back to a generic label.
async function assistantDisplayName(db: Database, storyId: string): Promise<string> {
	const [row] = await db
		.select({ llmConfig: users.llmConfig })
		.from(stories)
		.innerJoin(users, eq(stories.ownerId, users.id))
		.where(eq(stories.id, storyId));
	const raw = (row?.llmConfig ?? {}) as { assistantName?: unknown };
	return normaliseAssistantName(raw.assistantName) || 'Assistant';
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
		.where(
			and(eq(scenes.id, input.sceneId), eq(scenes.storyId, input.storyId), isNull(scenes.deletedAt))
		);
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
		// The Assistant authored it; the frontend can badge it.
		isAssistant: boolean;
		// The viewer passed to listThreads authored it, so they may retract it.
		mine: boolean;
		createdAt: Date;
	}[];
};

// Whoever is looking at the review: the signed-in owner, or a guest reviewer.
// Used to flag their own comments and suggestions as retractable.
export type ReviewViewer = { userId: string } | { reviewerId: string };

function ownsComment(
	comment: { authorUserId: string | null; authorReviewerId: string | null },
	viewer: ReviewViewer | undefined
): boolean {
	if (!viewer) return false;
	return 'userId' in viewer
		? comment.authorUserId === viewer.userId
		: comment.authorReviewerId === viewer.reviewerId;
}

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
	) => { start: number; end: number } | null,
	viewer?: ReviewViewer
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

	const assistantName = commentRows.some((c) => c.comment.assistant)
		? await assistantDisplayName(db, storyId)
		: 'Assistant';

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
					authorName: commentRow.comment.assistant
						? assistantName
						: commentRow.comment.authorUserId
							? (commentRow.userName ?? 'Author')
							: (commentRow.reviewerName ?? 'Reviewer'),
					isOwner: commentRow.comment.authorUserId !== null,
					isAssistant: commentRow.comment.assistant,
					mine: ownsComment(commentRow.comment, viewer),
					createdAt: commentRow.comment.createdAt
				}))
		};
	});
}

const MAX_REPLACEMENT_LENGTH = 20000;

// A reviewer proposes replacing [start, end) of the scene's current text with
// the replacement (equal offsets insert, an empty replacement deletes). The
// range is pinned to a base revision so the author's later edits re-anchor.
// Authored by the owner, a guest reviewer, or the Assistant, mirroring comments.
function suggestionAuthorColumns(author: ThreadAuthor) {
	if ('userId' in author) {
		return { authorUserId: author.userId, reviewerId: null, assistant: false };
	}
	if ('reviewerId' in author) {
		return { authorUserId: null, reviewerId: author.reviewerId, assistant: false };
	}
	return { authorUserId: null, reviewerId: null, assistant: true };
}

export async function createSuggestion(
	db: Database,
	input: {
		storyId: string;
		sceneId: string;
		author: ThreadAuthor;
		range: { start: number; end: number };
		replacement: string;
	}
): Promise<{ ok: true; suggestionId: string } | { ok: false; reason: string }> {
	if (input.replacement.length > MAX_REPLACEMENT_LENGTH) {
		return { ok: false, reason: 'That suggestion is too long.' };
	}
	const [scene] = await db
		.select({ id: scenes.id, bodyMd: scenes.bodyMd })
		.from(scenes)
		.where(
			and(eq(scenes.id, input.sceneId), eq(scenes.storyId, input.storyId), isNull(scenes.deletedAt))
		);
	if (!scene) return { ok: false, reason: 'That scene does not exist.' };
	const { start, end } = input.range;
	if (!Number.isInteger(start) || !Number.isInteger(end)) {
		return { ok: false, reason: 'That selection no longer matches the text.' };
	}
	if (start < 0 || end > scene.bodyMd.length || start > end) {
		return { ok: false, reason: 'That selection no longer matches the text.' };
	}
	if (scene.bodyMd.slice(start, end) === input.replacement) {
		return { ok: false, reason: 'That suggestion changes nothing.' };
	}

	const baseRevisionId = await ensureBaseRevision(db, scene.id, scene.bodyMd);
	const [row] = await db
		.insert(reviewSuggestions)
		.values({
			storyId: input.storyId,
			sceneId: input.sceneId,
			...suggestionAuthorColumns(input.author),
			baseRevisionId,
			rangeStart: start,
			rangeEnd: end,
			replacement: input.replacement
		})
		.returning({ id: reviewSuggestions.id });
	return { ok: true, suggestionId: row.id };
}

export type SuggestionView = {
	id: string;
	sceneId: string;
	reviewerName: string;
	// True when the author proposed it in their own review pass.
	isOwner: boolean;
	// The Assistant proposed it; the frontend can badge it.
	isAssistant: boolean;
	// The viewer passed to listSuggestions proposed it, so they may retract it
	// while it is still pending.
	mine: boolean;
	// What the suggestion replaces, as proposed against its base text.
	original: string;
	replacement: string;
	status: 'pending' | 'accepted' | 'rejected';
	// Where it lands in the current text; null when the passage has since
	// been rewritten, which also blocks accepting it.
	anchor: { start: number; end: number } | null;
	anchorLost: boolean;
	createdAt: Date;
	decidedAt: Date | null;
};

// Re-anchors the proposed range onto the current text: a real range maps
// through reanchorRange, a pure insertion point through reanchorPoint.
function mapSuggestionRange(
	baseText: string,
	currentText: string,
	start: number,
	end: number
): { start: number; end: number } | null {
	if (start === end) {
		const point = reanchorPoint(baseText, currentText, start);
		return point === null ? null : { start: point, end: point };
	}
	return reanchorRange(baseText, currentText, start, end);
}

export async function listSuggestions(
	db: Database,
	storyId: string,
	viewer?: ReviewViewer
): Promise<SuggestionView[]> {
	const rows = await db
		.select({
			suggestion: reviewSuggestions,
			baseBody: revisions.bodyMd,
			currentBody: scenes.bodyMd,
			reviewerName: reviewers.displayName,
			ownerName: users.displayName
		})
		.from(reviewSuggestions)
		.innerJoin(scenes, eq(reviewSuggestions.sceneId, scenes.id))
		.innerJoin(revisions, eq(reviewSuggestions.baseRevisionId, revisions.id))
		.leftJoin(reviewers, eq(reviewSuggestions.reviewerId, reviewers.id))
		.leftJoin(users, eq(reviewSuggestions.authorUserId, users.id))
		.where(eq(reviewSuggestions.storyId, storyId))
		.orderBy(asc(reviewSuggestions.createdAt));
	const assistantName = rows.some((r) => r.suggestion.assistant)
		? await assistantDisplayName(db, storyId)
		: 'Assistant';
	return rows.map((row) => {
		const { rangeStart, rangeEnd } = row.suggestion;
		// Decided suggestions keep their record but no longer point anywhere.
		const anchor =
			row.suggestion.status === 'pending'
				? mapSuggestionRange(row.baseBody, row.currentBody, rangeStart, rangeEnd)
				: null;
		const isOwner = row.suggestion.authorUserId !== null;
		const isAssistant = row.suggestion.assistant;
		const mine = viewer
			? 'userId' in viewer
				? row.suggestion.authorUserId === viewer.userId
				: row.suggestion.reviewerId === viewer.reviewerId
			: false;
		return {
			id: row.suggestion.id,
			sceneId: row.suggestion.sceneId,
			reviewerName: isAssistant
				? assistantName
				: isOwner
					? (row.ownerName ?? 'Author')
					: (row.reviewerName ?? 'Reviewer'),
			isOwner,
			isAssistant,
			mine,
			original: row.baseBody.slice(rangeStart, rangeEnd),
			replacement: row.suggestion.replacement,
			status: row.suggestion.status,
			anchor,
			anchorLost: row.suggestion.status === 'pending' && anchor === null,
			createdAt: row.suggestion.createdAt,
			decidedAt: row.suggestion.decidedAt
		};
	});
}

// The author's decision. Rejection only records it; acceptance re-anchors
// the range against the current text and applies the replacement, recording
// a revision and leaving the mention index to the caller's enqueue. A
// passage that was rewritten since cannot be accepted, only rejected.
export async function decideSuggestion(
	db: Database,
	userId: string,
	suggestionId: string,
	accept: boolean
): Promise<{ ok: true; sceneId: string | null } | { ok: false; reason: string }> {
	const [row] = await db
		.select({
			suggestion: reviewSuggestions,
			baseBody: revisions.bodyMd,
			scene: { id: scenes.id, bodyMd: scenes.bodyMd },
			ownerId: stories.ownerId
		})
		.from(reviewSuggestions)
		.innerJoin(scenes, eq(reviewSuggestions.sceneId, scenes.id))
		.innerJoin(revisions, eq(reviewSuggestions.baseRevisionId, revisions.id))
		.innerJoin(stories, eq(reviewSuggestions.storyId, stories.id))
		.where(eq(reviewSuggestions.id, suggestionId));
	if (!row || row.ownerId !== userId) {
		return { ok: false, reason: 'That suggestion does not exist.' };
	}
	if (row.suggestion.status !== 'pending') {
		return { ok: false, reason: 'That suggestion was already decided.' };
	}

	if (!accept) {
		await db
			.update(reviewSuggestions)
			.set({ status: 'rejected', decidedByUserId: userId, decidedAt: sql`now()` })
			.where(and(eq(reviewSuggestions.id, suggestionId), eq(reviewSuggestions.status, 'pending')));
		return { ok: true, sceneId: null };
	}

	// The body is read, re-anchored, and written inside one transaction with
	// the scene row locked, so a concurrent autosave cannot land between the
	// read and the write and be silently overwritten by stale text.
	const applied = await db.transaction(
		async (tx): Promise<{ ok: true; newBody: string } | { ok: false; reason: string }> => {
			const [scene] = await tx
				.select({ bodyMd: scenes.bodyMd })
				.from(scenes)
				.where(eq(scenes.id, row.scene.id))
				.for('update');
			if (!scene) return { ok: false, reason: 'That scene does not exist.' };
			const anchor = mapSuggestionRange(
				row.baseBody,
				scene.bodyMd,
				row.suggestion.rangeStart,
				row.suggestion.rangeEnd
			);
			if (!anchor) {
				return {
					ok: false,
					reason: 'The text this suggestion applies to has changed; it can only be rejected.'
				};
			}
			const newBody =
				scene.bodyMd.slice(0, anchor.start) +
				row.suggestion.replacement +
				scene.bodyMd.slice(anchor.end);
			// Guard the status inside the transaction so two decisions cannot
			// both apply; the loser matches no pending row and changes nothing.
			const decided = await tx
				.update(reviewSuggestions)
				.set({ status: 'accepted', decidedByUserId: userId, decidedAt: sql`now()` })
				.where(and(eq(reviewSuggestions.id, suggestionId), eq(reviewSuggestions.status, 'pending')))
				.returning({ id: reviewSuggestions.id });
			if (decided.length === 0)
				return { ok: false, reason: 'That suggestion was already decided.' };
			await tx
				.update(scenes)
				.set({ bodyMd: newBody, wordCount: wordCount(newBody) })
				.where(eq(scenes.id, row.scene.id));
			// Record the revision in the same transaction so the body change and
			// its snapshot commit together; a failure here rolls the accept back
			// rather than leaving an unsnapshotted edit.
			await recordRevision(tx, 'scene', row.scene.id, newBody, 'suggestion');
			return { ok: true, newBody };
		}
	);
	if (!applied.ok) return applied;
	return { ok: true, sceneId: row.scene.id };
}

// Accepts every pending suggestion in one scene, in creation order. Each accept
// re-anchors against the now-current text, so applying them one after another
// stays correct; a suggestion whose passage was rewritten cannot apply and is
// counted as failed rather than aborting the rest. Ownership is enforced per
// suggestion by decideSuggestion.
export async function acceptAllInScene(
	db: Database,
	userId: string,
	storyId: string,
	sceneId: string
): Promise<{ accepted: number; failed: number }> {
	const rows = await db
		.select({ id: reviewSuggestions.id })
		.from(reviewSuggestions)
		.where(
			and(
				eq(reviewSuggestions.storyId, storyId),
				eq(reviewSuggestions.sceneId, sceneId),
				eq(reviewSuggestions.status, 'pending')
			)
		)
		.orderBy(asc(reviewSuggestions.createdAt));
	let accepted = 0;
	let failed = 0;
	for (const row of rows) {
		const result = await decideSuggestion(db, userId, row.id, true);
		if (result.ok) accepted++;
		else failed++;
	}
	return { accepted, failed };
}

// Retracts a comment the viewer authored. A reply is removed on its own; the
// thread's opening comment can only be removed when no one else has joined the
// thread (so a retraction never takes someone else's reply with it), and then
// the whole thread goes. The Assistant's comments are not retractable here.
export async function deleteComment(
	db: Database,
	actor: ReviewViewer,
	commentId: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const [target] = await db.select().from(reviewComments).where(eq(reviewComments.id, commentId));
	if (!target) return { ok: false, reason: 'That comment does not exist.' };
	if (!ownsComment(target, actor)) {
		return { ok: false, reason: 'You can only delete your own comments.' };
	}
	const all = await db
		.select()
		.from(reviewComments)
		.where(eq(reviewComments.threadId, target.threadId))
		.orderBy(asc(reviewComments.createdAt));
	const isRoot = all[0]?.id === commentId;
	if (!isRoot) {
		await db.delete(reviewComments).where(eq(reviewComments.id, commentId));
		return { ok: true };
	}
	if (!all.every((comment) => ownsComment(comment, actor))) {
		return { ok: false, reason: 'Others have replied; resolve the thread instead.' };
	}
	await db.transaction(async (tx) => {
		await tx.delete(reviewComments).where(eq(reviewComments.threadId, target.threadId));
		await tx.delete(reviewThreads).where(eq(reviewThreads.id, target.threadId));
	});
	return { ok: true };
}

// Retracts a pending suggestion the viewer proposed. A decided suggestion is
// part of the record (and an accepted one already changed the text), so it
// stays.
export async function deleteSuggestion(
	db: Database,
	actor: ReviewViewer,
	suggestionId: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const [row] = await db
		.select()
		.from(reviewSuggestions)
		.where(eq(reviewSuggestions.id, suggestionId));
	if (!row) return { ok: false, reason: 'That suggestion does not exist.' };
	const mine =
		'userId' in actor ? row.authorUserId === actor.userId : row.reviewerId === actor.reviewerId;
	if (!mine) return { ok: false, reason: 'You can only delete your own suggestions.' };
	if (row.status !== 'pending') {
		return { ok: false, reason: 'That suggestion was already decided.' };
	}
	await db
		.delete(reviewSuggestions)
		.where(and(eq(reviewSuggestions.id, suggestionId), eq(reviewSuggestions.status, 'pending')));
	return { ok: true };
}
