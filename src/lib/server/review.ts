import { randomBytes } from 'node:crypto';
import { normaliseReason } from '#lib/suggestion-reason';
import { textHash } from '#lib/text-hash';
import {
	and,
	asc,
	count,
	desc,
	eq,
	gt,
	inArray,
	isNull,
	or,
	sql,
	type AnyColumn,
	type SQL
} from 'drizzle-orm';
import { clientDisplayName } from '../mcp-access.ts';
import type { Database } from './auth.ts';
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
} from './db/schema.ts';
import { hashToken } from './tokens.ts';
import { storyIsLive } from './universe-scope.ts';
import { signToken, verifyToken } from './crypto.ts';
import { recordRevision } from './revisions.ts';
import { remapMarkerAnchors } from './markers.ts';
import { createAnchorMapper, type AnchorMapper } from '../review-anchor.ts';
import { wordCount } from '../word-count.ts';
import { normaliseAssistantName } from './llm/prompts/persona.ts';
import { EMAIL_RE } from './signup.ts';
import { isForeignKeyViolation } from './db-errors.ts';

// Guest review: invitations, guest identity, threaded comments, and
// suggested edits. An author invites someone to one story by magic link; the
// guest reads the manuscript, leaves comments anchored to text ranges, and
// proposes edits, and the author replies, resolves, and decides. Only the
// link token's hash is stored, and revoking an invitation cuts access while
// keeping the threads.

// The body caps live here, in the functions every caller goes through
// (author actions, guest actions, assistant tools), not per route.
export const MAX_COMMENT_LENGTH = 5000;
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
// page can say which. A story in a trashed universe reads as an unknown link.
export async function invitationByToken(db: Database, token: string) {
	const [row] = await db
		.select({
			invitation: reviewInvitations,
			storyTitle: stories.title,
			storyOwnerId: stories.ownerId
		})
		.from(reviewInvitations)
		.innerJoin(stories, eq(reviewInvitations.storyId, stories.id))
		.where(and(eq(reviewInvitations.tokenHash, hashToken(token)), storyIsLive()));
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

export async function ensureReviewer(
	db: Database,
	invitationId: string,
	identity: { userId: string; displayName: string } | { displayName: string; email?: string }
) {
	if ('userId' in identity) {
		// Upsert against the partial unique index so two concurrent first
		// requests settle on one row instead of splitting attribution.
		const [created] = await db
			.insert(reviewers)
			.values({
				invitationId,
				userId: identity.userId,
				displayName: identity.displayName
			})
			.onConflictDoNothing()
			.returning();
		if (created) return created;
		const [existing] = await db
			.select()
			.from(reviewers)
			.where(and(eq(reviewers.invitationId, invitationId), eq(reviewers.userId, identity.userId)));
		return existing;
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
			email: EMAIL_RE.test(email) ? email : null
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
// invitation must still grant access to this story, whose universe must not
// be in the trash. Touches last_seen_at.
export async function reviewerAccess(db: Database, reviewerId: string, storyId: string) {
	const [row] = await db
		.select({ reviewer: reviewers, invitation: reviewInvitations })
		.from(reviewers)
		.innerJoin(reviewInvitations, eq(reviewers.invitationId, reviewInvitations.id))
		.innerJoin(stories, eq(reviewInvitations.storyId, stories.id))
		.where(
			and(
				eq(reviewers.id, reviewerId),
				eq(reviewInvitations.storyId, storyId),
				storyIsLive(),
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
// anchor always has the exact text it was placed against. Must run inside a
// transaction holding the scene's revision advisory lock (sceneRevisionLock):
// between reading the latest revision here and the caller pinning it, an
// unserialised autosave could roll the revision's body forward and the anchor
// would point at text it was never placed on.
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
		.values({
			entityType: 'scene',
			entityId: sceneId,
			bodyMd,
			wordCount: wordCount(bodyMd),
			reason: 'autosave'
		})
		.returning({ id: revisions.id });
	return created.id;
}

// The same per-entity advisory lock recordRevision takes for autosave
// coalescing, so pinning a base revision serialises against autosaves. The
// scene row is locked first, the order a save takes them in (row, then
// advisory), so the two cannot deadlock.
async function sceneRevisionLock(db: Database, sceneId: string): Promise<void> {
	await db.select({ id: scenes.id }).from(scenes).where(eq(scenes.id, sceneId)).for('key share');
	await db.execute(sql`select pg_advisory_xact_lock(hashtext(${`scene:${sceneId}`}))`);
}

// A comment or suggestion is authored by the signed-in owner, a guest
// reviewer, the Assistant, or an outside app the owner connected. The
// Assistant carries no FK; its display name is resolved live from the owner's
// config (assistantDisplayName). An app is the registered client it connected
// as; its name and host are copied onto each row (see the schema).
export type ClientAuthor = { id: string; name: string; host: string };
// The two authors that are programs. They share the rules a person does not
// need: a repeat of their own note is dropped, and only they revise their own
// pending suggestion.
export type MachineAuthor = { assistant: true } | { client: ClientAuthor };
export type ThreadAuthor = { userId: string } | { reviewerId: string } | MachineAuthor;

function isMachine(author: ThreadAuthor): author is MachineAuthor {
	return 'assistant' in author || 'client' in author;
}

function clientColumns(author: ThreadAuthor) {
	return 'client' in author
		? {
				clientId: author.client.id,
				clientName: author.client.name,
				clientHost: author.client.host
			}
		: { clientId: null, clientName: null, clientHost: null };
}

function commentAuthorColumns(author: ThreadAuthor) {
	const client = clientColumns(author);
	if ('userId' in author) {
		return { authorUserId: author.userId, authorReviewerId: null, assistant: false, ...client };
	}
	if ('reviewerId' in author) {
		return {
			authorUserId: null,
			authorReviewerId: author.reviewerId,
			assistant: false,
			...client
		};
	}
	return {
		authorUserId: null,
		authorReviewerId: null,
		assistant: 'assistant' in author,
		...client
	};
}

// A where-clause condition: the row was written by this program.
function writtenBy(
	table: typeof reviewComments | typeof reviewSuggestions,
	author: MachineAuthor
): SQL {
	return 'assistant' in author ? eq(table.assistant, true) : eq(table.clientId, author.client.id);
}

// How a row's author is shown when an app wrote it; null for any other
// author. The one place the stored name and host become a label, so it reads
// the same after the client row itself is gone.
function clientAuthorName(row: {
	clientName: string | null;
	clientHost: string | null;
}): string | null {
	if (row.clientHost === null) return null;
	return clientDisplayName({ clientName: row.clientName ?? '', host: row.clientHost });
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

// Whether the Assistant (or the app) already has an open comment saying
// exactly this, in the same place. A weak model repeats a tool call within a
// run and across runs; the repeat is dropped instead of stacking identical
// cards on the author's review. Only a program's own writes are deduped, and
// only while the thread is unresolved, so an author who wants the same note
// twice still gets it and a resolved note can be raised again.
async function ownThreadExists(
	db: Database,
	author: MachineAuthor,
	sceneId: string,
	anchor: { start: number; end: number } | null,
	body: string
): Promise<boolean> {
	const [row] = await db
		.select({ id: reviewThreads.id })
		.from(reviewThreads)
		.innerJoin(reviewComments, eq(reviewComments.threadId, reviewThreads.id))
		.where(
			and(
				eq(reviewThreads.sceneId, sceneId),
				isNull(reviewThreads.suggestionId),
				isNull(reviewThreads.resolvedAt),
				anchor
					? and(
							eq(reviewThreads.anchorStart, anchor.start),
							eq(reviewThreads.anchorEnd, anchor.end)
						)
					: and(isNull(reviewThreads.anchorStart), isNull(reviewThreads.anchorEnd)),
				writtenBy(reviewComments, author),
				eq(reviewComments.bodyMd, body)
			)
		)
		.limit(1);
	return Boolean(row);
}

// The Assistant's (or the app's) open whole-scene note on a scene that begins
// with this text, for a pattern note retried with the same comment: the retry
// adds its edits to the note rather than opening a second one.
export async function openAssistantNote(
	db: Database,
	sceneId: string,
	opening: string,
	author: MachineAuthor = { assistant: true }
): Promise<string | null> {
	const [row] = await db
		.select({ id: reviewThreads.id })
		.from(reviewThreads)
		.innerJoin(reviewComments, eq(reviewComments.threadId, reviewThreads.id))
		.where(
			and(
				eq(reviewThreads.sceneId, sceneId),
				isNull(reviewThreads.suggestionId),
				isNull(reviewThreads.resolvedAt),
				isNull(reviewThreads.anchorStart),
				writtenBy(reviewComments, author),
				sql`starts_with(${reviewComments.bodyMd}, ${opening})`,
				// The note's own opening comment, not a reply in its thread.
				sql`not exists (select 1 from ${reviewComments} as earlier where earlier.thread_id = ${reviewThreads.id} and earlier.created_at < ${reviewComments.createdAt})`
			)
		)
		.orderBy(asc(reviewThreads.createdAt))
		.limit(1);
	return row?.id ?? null;
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

	if (isMachine(input.author)) {
		const duplicate = await ownThreadExists(db, input.author, input.sceneId, input.anchor, body);
		if (duplicate) {
			return {
				ok: false,
				reason: 'You have already left this comment on this scene; do not repeat it.'
			};
		}
	}

	const threadId = await db.transaction(async (tx) => {
		let baseRevisionId: string | null = null;
		if (input.anchor) {
			await sceneRevisionLock(tx, scene.id);
			baseRevisionId = await ensureBaseRevision(tx, scene.id, scene.bodyMd);
		}
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

// A suggestion's discussion thread, created lazily on the first reply. The
// thread carries no anchor or opening comment of its own: the suggestion's
// card is the anchor, and the first reply is the first comment. Idempotent -
// the unique suggestion_id makes a concurrent first reply settle on one row.
export async function ensureSuggestionThread(
	db: Database,
	input: { storyId: string; suggestionId: string }
): Promise<{ ok: true; threadId: string } | { ok: false; reason: string }> {
	const [suggestion] = await db
		.select({ id: reviewSuggestions.id, sceneId: reviewSuggestions.sceneId })
		.from(reviewSuggestions)
		.where(
			and(
				eq(reviewSuggestions.id, input.suggestionId),
				eq(reviewSuggestions.storyId, input.storyId)
			)
		);
	if (!suggestion) return { ok: false, reason: 'That suggestion does not exist.' };
	let created: { id: string } | undefined;
	try {
		[created] = await db
			.insert(reviewThreads)
			.values({
				storyId: input.storyId,
				sceneId: suggestion.sceneId,
				suggestionId: suggestion.id
			})
			.onConflictDoNothing({ target: reviewThreads.suggestionId })
			.returning({ id: reviewThreads.id });
	} catch (err) {
		// The suggestion was cleared between the check and the insert.
		if (isForeignKeyViolation(err)) return { ok: false, reason: 'That suggestion does not exist.' };
		throw err;
	}
	if (created) return { ok: true, threadId: created.id };
	const [existing] = await db
		.select({ id: reviewThreads.id })
		.from(reviewThreads)
		.where(eq(reviewThreads.suggestionId, suggestion.id));
	return existing
		? { ok: true, threadId: existing.id }
		: { ok: false, reason: 'That thread could not be created.' };
}

// Replies to an existing thread. The caller has already established the
// author's right to this story; the thread only needs to belong to it.
export async function addComment(
	db: Database,
	input: { storyId: string; threadId: string; author: ThreadAuthor; body: string }
): Promise<{ ok: true; commentId: string } | { ok: false; reason: string }> {
	const body = input.body.trim();
	if (!body) return { ok: false, reason: 'Write a comment first.' };
	if (body.length > MAX_COMMENT_LENGTH) {
		return { ok: false, reason: 'That comment is too long.' };
	}
	// The thread row is locked with the insert so a reply cannot land between
	// a retraction's "everyone here is me" check and its delete; the retraction
	// takes the same lock.
	const inserted = await db.transaction(async (tx) => {
		const [thread] = await tx
			.select({ id: reviewThreads.id })
			.from(reviewThreads)
			.where(and(eq(reviewThreads.id, input.threadId), eq(reviewThreads.storyId, input.storyId)))
			.for('update');
		if (!thread) return null;
		const [comment] = await tx
			.insert(reviewComments)
			.values({
				threadId: thread.id,
				...commentAuthorColumns(input.author),
				bodyMd: body
			})
			.returning({ id: reviewComments.id });
		return comment.id;
	});
	if (!inserted) return { ok: false, reason: 'That thread does not exist.' };
	return { ok: true, commentId: inserted };
}

// Only the story's owner resolves or reopens a thread, and only one of that
// story's threads.
export async function setThreadResolved(
	db: Database,
	userId: string,
	storyId: string,
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
				eq(reviewThreads.storyId, storyId),
				inArray(
					reviewThreads.storyId,
					db
						.select({ id: stories.id })
						.from(stories)
						.where(and(eq(stories.ownerId, userId), storyIsLive()))
				)
			)
		)
		.returning({ id: reviewThreads.id });
	return updated.length > 0;
}

export type ThreadView = {
	id: string;
	sceneId: string;
	// Set when this thread is a suggestion's discussion; it renders on that
	// suggestion's card, not in the standalone comment list.
	suggestionId: string | null;
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
		// An outside app authored it; authorName is the app's name and host.
		isApp: boolean;
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
			suggestionId: row.thread.suggestionId,
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
							: (clientAuthorName(commentRow.comment) ?? commentRow.reviewerName ?? 'Reviewer'),
					isOwner: commentRow.comment.authorUserId !== null,
					isAssistant: commentRow.comment.assistant,
					isApp: commentRow.comment.clientHost !== null,
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
	const client = clientColumns(author);
	if ('userId' in author) {
		return { authorUserId: author.userId, reviewerId: null, assistant: false, ...client };
	}
	if ('reviewerId' in author) {
		return { authorUserId: null, reviewerId: author.reviewerId, assistant: false, ...client };
	}
	return { authorUserId: null, reviewerId: null, assistant: 'assistant' in author, ...client };
}

// How many notes an app has waiting on a scene: its pending suggestions and
// the open comments it started. The caller holds this against a ceiling, so
// an app stuck in a loop cannot bury the writer's review.
export async function clientNotesWaiting(
	db: Database,
	sceneId: string,
	clientId: string
): Promise<number> {
	const [suggestions] = await db
		.select({ n: count() })
		.from(reviewSuggestions)
		.where(
			and(
				eq(reviewSuggestions.sceneId, sceneId),
				eq(reviewSuggestions.clientId, clientId),
				eq(reviewSuggestions.status, 'pending')
			)
		);
	const [threads] = await db
		.select({ n: count() })
		.from(reviewThreads)
		.where(
			and(
				eq(reviewThreads.sceneId, sceneId),
				isNull(reviewThreads.suggestionId),
				isNull(reviewThreads.resolvedAt),
				// Opened by the app: its comment is the thread's first. The outer
				// column is spelled out because a single-table query renders
				// column references without their table.
				sql`(select opener.client_id from review_comments as opener where opener.thread_id = "review_threads"."id" order by opener.created_at limit 1) = ${clientId}`
			)
		);
	return suggestions.n + threads.n;
}

export async function createSuggestion(
	db: Database,
	input: {
		storyId: string;
		sceneId: string;
		author: ThreadAuthor;
		range: { start: number; end: number };
		replacement: string;
		// The Assistant's pattern note this edit is an instance of. It must be a
		// standalone thread of the same story; it may sit on another scene.
		patternThreadId?: string;
		// The accepted edit whose re-read staged this one as a follow-up. Only
		// the re-read sets it, from an edit it has checked is the owner's and in
		// the same scene.
		followsSuggestionId?: string;
		// Why the Assistant suggests it, shown to the author.
		reason?: string;
		// The text the range was found on, where the caller located it on its
		// own copy of the scene: refused when the scene no longer has it there.
		original?: string;
	}
): Promise<{ ok: true; suggestionId: string } | { ok: false; reason: string }> {
	if (input.replacement.length > MAX_REPLACEMENT_LENGTH) {
		return { ok: false, reason: 'That suggestion is too long.' };
	}
	if (input.patternThreadId) {
		const [note] = await db
			.select({ id: reviewThreads.id, resolvedAt: reviewThreads.resolvedAt })
			.from(reviewThreads)
			.where(
				and(
					eq(reviewThreads.id, input.patternThreadId),
					eq(reviewThreads.storyId, input.storyId),
					isNull(reviewThreads.suggestionId)
				)
			);
		if (!note) return { ok: false, reason: 'That pattern note does not exist.' };
		// A request still running when the writer resolves the note stages
		// nothing more on it.
		if (note.resolvedAt) return { ok: false, reason: 'That pattern note is resolved.' };
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
	if (input.original !== undefined && scene.bodyMd.slice(start, end) !== input.original) {
		return {
			ok: false,
			reason: 'The scene changed while this was staged; find the passage again.'
		};
	}
	if (scene.bodyMd.slice(start, end) === input.replacement) {
		return { ok: false, reason: 'That suggestion changes nothing.' };
	}

	// The Assistant or an app repeating itself stages nothing new (see
	// ownThreadExists). The range is compared as stored, against whichever
	// base revision the earlier suggestion pinned: a repeat inside one review
	// pass is measured on the same unchanged body, and once the body moves the
	// offsets are a different proposal anyway.
	if (isMachine(input.author)) {
		const [duplicate] = await db
			.select({ id: reviewSuggestions.id })
			.from(reviewSuggestions)
			.where(
				and(
					eq(reviewSuggestions.sceneId, input.sceneId),
					writtenBy(reviewSuggestions, input.author),
					eq(reviewSuggestions.status, 'pending'),
					eq(reviewSuggestions.rangeStart, start),
					eq(reviewSuggestions.rangeEnd, end),
					eq(reviewSuggestions.replacement, input.replacement)
				)
			)
			.limit(1);
		if (duplicate) {
			return {
				ok: false,
				reason: 'You have already staged this exact edit on this scene; do not repeat it.'
			};
		}
	}

	const rows = await db.transaction(async (tx) => {
		await sceneRevisionLock(tx, scene.id);
		// A save between the read above and the lock moves the text under the
		// range, so the range is pinned only to the body it was checked on.
		const [current] = await tx
			.select({ bodyMd: scenes.bodyMd })
			.from(scenes)
			.where(eq(scenes.id, scene.id));
		if (current?.bodyMd !== scene.bodyMd) return [];
		const baseRevisionId = await ensureBaseRevision(tx, scene.id, scene.bodyMd);
		return await tx
			.insert(reviewSuggestions)
			.values({
				storyId: input.storyId,
				sceneId: input.sceneId,
				...suggestionAuthorColumns(input.author),
				baseRevisionId,
				rangeStart: start,
				rangeEnd: end,
				replacement: input.replacement,
				patternThreadId: input.patternThreadId ?? null,
				followsSuggestionId: input.followsSuggestionId ?? null,
				reason: normaliseReason(input.reason)
			})
			.returning({ id: reviewSuggestions.id });
	});
	const [row] = rows;
	if (!row) {
		return {
			ok: false,
			reason: 'The scene changed while this was staged; find the passage again.'
		};
	}
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
	// An outside app proposed it; reviewerName is the app's name and host.
	isApp: boolean;
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
	// The Assistant pattern note this edit belongs to, if any.
	patternThreadId: string | null;
	// The edit whose re-read after an accept staged this one, if any.
	followsId: string | null;
	// The Assistant's short reason for the change, if it gave one.
	reason: string | null;
	createdAt: Date;
	decidedAt: Date | null;
};

// Re-anchors the proposed range onto the current text: a real range maps
// through the mapper's range, a pure insertion point through its point.
// Unlike a comment anchor, a suggestion replaces the range wholesale, so the
// range must still hold exactly the text it was proposed against: an edit
// inside it (which the mapper tolerates by stretching or shrinking) would be
// silently overwritten on accept, so it counts as lost. A character diff can
// also stretch the range over an insertion just outside it ("She walked in."
// -> "She slowly walked in." maps "walked in" to "wly walked in"), so the
// original is looked for inside the stretched range before giving up.
function mapSuggestionRange(
	mapper: AnchorMapper,
	baseText: string,
	currentText: string,
	start: number,
	end: number
): { start: number; end: number } | null {
	if (start === end) {
		const point = mapper.point(baseText, currentText, start);
		return point === null ? null : { start: point, end: point };
	}
	const range = mapper.range(baseText, currentText, start, end);
	if (!range) return null;
	const original = baseText.slice(start, end);
	if (currentText.slice(range.start, range.end) === original) return range;
	const at = currentText.indexOf(original, range.start);
	if (at === -1 || at + original.length > range.end) return null;
	return { start: at, end: at + original.length };
}

// Where a decided suggestion now sits, so the Done view can point at it: the
// accepted replacement (the new text it left behind) or the rejected original
// (still in place). Null when there is nothing to mark or it cannot be found.
function decidedAnchor(
	mapper: AnchorMapper,
	status: 'accepted' | 'rejected',
	baseText: string,
	currentText: string,
	start: number,
	end: number,
	replacement: string
): { start: number; end: number } | null {
	if (status === 'rejected') {
		// Rejection left the text untouched, so the original passage maps as-is.
		if (start === end) return null; // a rejected insertion left no text
		return mapper.range(baseText, currentText, start, end);
	}
	// Accepted: the replacement now occupies the spot the original held.
	if (replacement.length === 0) return null; // a deletion leaves nothing to mark
	const point = mapper.point(baseText, currentText, start);
	if (point === null) return null;
	const at = { start: point, end: point + replacement.length };
	return at.end <= currentText.length ? at : null;
}

// The mapper is shared with listThreads when both run for the same story, so
// each scene revision is diffed once for the whole page rather than once per
// thread and once per suggestion.
export async function listSuggestions(
	db: Database,
	storyId: string,
	viewer?: ReviewViewer,
	mapper: AnchorMapper = createAnchorMapper()
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
		// A pending suggestion anchors to where it would apply; a decided one
		// anchors to where it now sits, so the Done view can point at it.
		const anchor =
			row.suggestion.status === 'pending'
				? mapSuggestionRange(mapper, row.baseBody, row.currentBody, rangeStart, rangeEnd)
				: decidedAnchor(
						mapper,
						row.suggestion.status,
						row.baseBody,
						row.currentBody,
						rangeStart,
						rangeEnd,
						row.suggestion.replacement
					);
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
					: (clientAuthorName(row.suggestion) ?? row.reviewerName ?? 'Reviewer'),
			isOwner,
			isAssistant,
			isApp: row.suggestion.clientHost !== null,
			mine,
			original: row.baseBody.slice(rangeStart, rangeEnd),
			replacement: row.suggestion.replacement,
			status: row.suggestion.status,
			anchor,
			anchorLost: row.suggestion.status === 'pending' && anchor === null,
			patternThreadId: row.suggestion.patternThreadId,
			followsId: row.suggestion.followsSuggestionId,
			reason: row.suggestion.reason,
			createdAt: row.suggestion.createdAt,
			decidedAt: row.suggestion.decidedAt
		};
	});
}

// An accepted Assistant edit that belongs to a pattern note, with where its
// new text now sits in the scene (a deletion is the point where the text was
// taken out), for the re-read after an accept. Null unless the story is the
// owner's, the suggestion is accepted, and it is linked to a note; spot is null
// when the change can no longer be found in the current text.
export async function acceptedPatternEdit(
	db: Database,
	userId: string,
	suggestionId: string
): Promise<{
	storyId: string;
	sceneId: string;
	patternThreadId: string;
	replacement: string;
	bodyMd: string;
	sceneTitle: string | null;
	spot: { start: number; end: number } | null;
} | null> {
	const [row] = await db
		.select({
			suggestion: reviewSuggestions,
			baseBody: revisions.bodyMd,
			bodyMd: scenes.bodyMd,
			sceneTitle: scenes.title
		})
		.from(reviewSuggestions)
		.innerJoin(scenes, eq(reviewSuggestions.sceneId, scenes.id))
		.innerJoin(revisions, eq(reviewSuggestions.baseRevisionId, revisions.id))
		.innerJoin(stories, eq(reviewSuggestions.storyId, stories.id))
		.where(and(eq(reviewSuggestions.id, suggestionId), eq(stories.ownerId, userId), storyIsLive()));
	const suggestion = row?.suggestion;
	if (!suggestion || suggestion.status !== 'accepted' || !suggestion.patternThreadId) return null;
	// The new text sits where the original was, so either edge of the original
	// can place it; whichever edge still lies in unchanged text is used, and the
	// replacement must be found right there.
	const mapper = createAnchorMapper();
	const length = suggestion.replacement.length;
	const holds = (start: number) =>
		start >= 0 && row.bodyMd.slice(start, start + length) === suggestion.replacement;
	const before = mapper.point(row.baseBody, row.bodyMd, suggestion.rangeStart);
	const after = mapper.point(row.baseBody, row.bodyMd, suggestion.rangeEnd);
	let spot: { start: number; end: number } | null = null;
	if (before !== null && holds(before)) spot = { start: before, end: before + length };
	else if (after !== null && holds(after - length)) spot = { start: after - length, end: after };
	return {
		storyId: suggestion.storyId,
		sceneId: suggestion.sceneId,
		patternThreadId: suggestion.patternThreadId,
		replacement: suggestion.replacement,
		bodyMd: row.bodyMd,
		sceneTitle: row.sceneTitle,
		spot
	};
}

// Revises the replacement text of the Assistant's own pending suggestion (or
// an app's own) - the discussion path where the author asks for a change and
// the Assistant amends what it proposed. Never touches another author's
// suggestion or a decided one, and only the replacement: the anchored range
// stays put.
export async function updateAssistantSuggestion(
	db: Database,
	input: { storyId: string; suggestionId: string; replacement: string; author?: MachineAuthor }
): Promise<{ ok: true } | { ok: false; reason: string }> {
	if (input.replacement.length > MAX_REPLACEMENT_LENGTH) {
		return { ok: false, reason: 'That suggestion is too long.' };
	}
	const updated = await db
		.update(reviewSuggestions)
		.set({ replacement: input.replacement })
		.where(
			and(
				eq(reviewSuggestions.id, input.suggestionId),
				eq(reviewSuggestions.storyId, input.storyId),
				writtenBy(reviewSuggestions, input.author ?? { assistant: true }),
				eq(reviewSuggestions.status, 'pending')
			)
		)
		.returning({ id: reviewSuggestions.id });
	if (updated.length === 0) {
		return {
			ok: false,
			reason: input.author
				? 'You can only revise a suggestion you made, and only while it is pending.'
				: 'Only the Assistant can revise its own suggestion, and only while it is pending.'
		};
	}
	return { ok: true };
}

// The author's decision. Rejection only records it; acceptance re-anchors
// the range against the current text and applies the replacement, recording
// a revision and leaving the mention index to the caller's enqueue. A
// passage that was edited since, even inside it, cannot be accepted, only
// rejected.
//
// override is the owner's own wording, accepted in place of the proposed
// replacement (the guided pass's Edit). The suggestion then records the text
// that was applied.
export async function decideSuggestion(
	db: Database,
	userId: string,
	storyId: string,
	suggestionId: string,
	accept: boolean,
	override?: string
): Promise<
	| { ok: true; sceneId: string | null; bodyMd: string | null; baseHash: string | null }
	| { ok: false; reason: string }
> {
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
		.where(
			and(
				eq(reviewSuggestions.id, suggestionId),
				eq(reviewSuggestions.storyId, storyId),
				storyIsLive()
			)
		);
	if (!row || row.ownerId !== userId) {
		return { ok: false, reason: 'That suggestion does not exist.' };
	}
	if (row.suggestion.status !== 'pending') {
		return { ok: false, reason: 'That suggestion was already decided.' };
	}
	if (override !== undefined) {
		// Rewording is the guided pass's Edit, on a pattern note's own edits; any
		// other suggestion is taken or left as its author proposed it.
		if (!row.suggestion.patternThreadId) {
			return { ok: false, reason: 'Only the edits of a pattern note can be reworded here.' };
		}
		if (override.length > MAX_REPLACEMENT_LENGTH) {
			return { ok: false, reason: 'That suggestion is too long.' };
		}
		if (!override.trim() && row.suggestion.replacement !== '') {
			return { ok: false, reason: 'Write the wording to use, or skip this change.' };
		}
	}
	const replacement = accept && override !== undefined ? override : row.suggestion.replacement;

	if (!accept) {
		await db
			.update(reviewSuggestions)
			.set({ status: 'rejected', decidedByUserId: userId, decidedAt: sql`now()` })
			.where(and(eq(reviewSuggestions.id, suggestionId), eq(reviewSuggestions.status, 'pending')));
		return { ok: true, sceneId: null, bodyMd: null, baseHash: null };
	}

	// The body is read, re-anchored, and written inside one transaction with
	// the scene row locked, so a concurrent autosave cannot land between the
	// read and the write and be silently overwritten by stale text.
	const applied = await db.transaction(
		async (
			tx
		): Promise<{ ok: true; newBody: string; baseHash: string } | { ok: false; reason: string }> => {
			const [scene] = await tx
				.select({ bodyMd: scenes.bodyMd })
				.from(scenes)
				.where(eq(scenes.id, row.scene.id))
				.for('update');
			if (!scene) return { ok: false, reason: 'That scene does not exist.' };
			// One anchor against the text just read under the lock, so there is
			// nothing for a shared mapper to reuse.
			const anchor = mapSuggestionRange(
				createAnchorMapper(),
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
				scene.bodyMd.slice(0, anchor.start) + replacement + scene.bodyMd.slice(anchor.end);
			// Guard the status inside the transaction so two decisions cannot
			// both apply; the loser matches no pending row and changes nothing.
			const decided = await tx
				.update(reviewSuggestions)
				.set({ status: 'accepted', decidedByUserId: userId, decidedAt: sql`now()`, replacement })
				.where(and(eq(reviewSuggestions.id, suggestionId), eq(reviewSuggestions.status, 'pending')))
				.returning({ id: reviewSuggestions.id });
			if (decided.length === 0)
				return { ok: false, reason: 'That suggestion was already decided.' };
			await tx
				.update(scenes)
				.set({ bodyMd: newBody, wordCount: wordCount(newBody) })
				.where(eq(scenes.id, row.scene.id));
			await remapMarkerAnchors(tx, row.scene.id, scene.bodyMd, newBody);
			// Record the revision in the same transaction so the body change and
			// its snapshot commit together; a failure here rolls the accept back
			// rather than leaving an unsnapshotted edit.
			await recordRevision(tx, 'scene', row.scene.id, newBody, 'suggestion');
			return { ok: true, newBody, baseHash: textHash(scene.bodyMd) };
		}
	);
	if (!applied.ok) return applied;
	return {
		ok: true,
		sceneId: row.scene.id,
		bodyMd: applied.newBody,
		baseHash: applied.baseHash
	};
}

// The most suggestions one bulk decision takes. A scene rarely holds more
// pending edits than this; the rest can go in a second round.
export const BULK_DECISION_MAX = 200;

export type BulkDecision = {
	// The suggestions the decision was applied to, in the order given.
	decided: string[];
	// The ones it was not applied to, each with why.
	failed: { id: string; reason: string }[];
	// After an accept that changed one scene and nothing else wrote to it in
	// between: the scene, its text now, and the fingerprint of its text before
	// the first change. Null otherwise, and for a reject.
	accepted: { sceneId: string; bodyMd: string; baseHash: string } | null;
	// Every scene whose text an accept changed.
	sceneIds: string[];
};

// The author's decision on several suggestions the review toolbar listed and
// the author ticked. Each goes through decideSuggestion on its own, so each
// accept is checked against the text as it stands after the ones before it,
// and gets its own history entry. One that cannot be applied (its passage
// changed, or it was decided meanwhile) is reported and the rest carry on.
export async function decideSuggestions(
	db: Database,
	userId: string,
	storyId: string,
	suggestionIds: string[],
	accept: boolean
): Promise<BulkDecision> {
	const decided: string[] = [];
	const failed: BulkDecision['failed'] = [];
	const changes: { sceneId: string; bodyMd: string; baseHash: string }[] = [];
	for (const id of new Set(suggestionIds)) {
		const result = await decideSuggestion(db, userId, storyId, id, accept);
		if (!result.ok) {
			failed.push({ id, reason: result.reason });
			continue;
		}
		decided.push(id);
		if (result.sceneId && result.bodyMd !== null && result.baseHash !== null) {
			changes.push({ sceneId: result.sceneId, bodyMd: result.bodyMd, baseHash: result.baseHash });
		}
	}
	// The open editor may only build on the final text when every change was
	// made to the text the one before it left: one scene, and no other write
	// in between.
	const chained = changes.every(
		(change, i) =>
			i === 0 ||
			(change.sceneId === changes[0].sceneId && change.baseHash === textHash(changes[i - 1].bodyMd))
	);
	return {
		decided,
		failed,
		accepted:
			changes.length > 0 && chained
				? {
						sceneId: changes[0].sceneId,
						bodyMd: changes[changes.length - 1].bodyMd,
						baseHash: changes[0].baseHash
					}
				: null,
		sceneIds: [...new Set(changes.map((change) => change.sceneId))]
	};
}

// Retracts a comment the viewer authored. A reply is removed on its own; the
// thread's opening comment can only be removed when no one else has joined the
// thread (so a retraction never takes someone else's reply with it), and then
// the whole thread goes. The Assistant's comments are not retractable here.
// Scoped to the given story, in a live universe.
export async function deleteComment(
	db: Database,
	actor: ReviewViewer,
	storyId: string,
	commentId: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const [found] = await db
		.select({ comment: reviewComments })
		.from(reviewComments)
		.innerJoin(reviewThreads, eq(reviewComments.threadId, reviewThreads.id))
		.innerJoin(stories, eq(reviewThreads.storyId, stories.id))
		.where(
			and(eq(reviewComments.id, commentId), eq(reviewThreads.storyId, storyId), storyIsLive())
		);
	const target = found?.comment;
	if (!target) return { ok: false, reason: 'That comment does not exist.' };
	if (!ownsComment(target, actor)) {
		return { ok: false, reason: 'You can only delete your own comments.' };
	}
	// Checked and deleted under the thread's row lock (addComment takes the
	// same lock), so a reply cannot land between the "everyone here is me"
	// check and the delete and vanish with the thread.
	return await db.transaction(async (tx) => {
		await tx
			.select({ id: reviewThreads.id })
			.from(reviewThreads)
			.where(eq(reviewThreads.id, target.threadId))
			.for('update');
		const all = await tx
			.select()
			.from(reviewComments)
			.where(eq(reviewComments.threadId, target.threadId))
			.orderBy(asc(reviewComments.createdAt));
		const isRoot = all[0]?.id === commentId;
		if (!isRoot) {
			await tx.delete(reviewComments).where(eq(reviewComments.id, commentId));
			return { ok: true };
		}
		if (!all.every((comment) => ownsComment(comment, actor))) {
			return { ok: false, reason: 'Others have replied; resolve the thread instead.' };
		}
		await tx.delete(reviewComments).where(eq(reviewComments.threadId, target.threadId));
		await tx.delete(reviewThreads).where(eq(reviewThreads.id, target.threadId));
		return { ok: true };
	});
}

// Retracts a pending suggestion the viewer proposed. A decided suggestion is
// part of the record (and an accepted one already changed the text), so it
// stays. Scoped to the given story, in a live universe.
export async function deleteSuggestion(
	db: Database,
	actor: ReviewViewer,
	storyId: string,
	suggestionId: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const [found] = await db
		.select({ suggestion: reviewSuggestions })
		.from(reviewSuggestions)
		.innerJoin(stories, eq(reviewSuggestions.storyId, stories.id))
		.where(
			and(
				eq(reviewSuggestions.id, suggestionId),
				eq(reviewSuggestions.storyId, storyId),
				storyIsLive()
			)
		);
	const row = found?.suggestion;
	if (!row) return { ok: false, reason: 'That suggestion does not exist.' };
	const mine =
		'userId' in actor ? row.authorUserId === actor.userId : row.reviewerId === actor.reviewerId;
	if (!mine) return { ok: false, reason: 'You can only delete your own suggestions.' };
	if (row.status !== 'pending') {
		return { ok: false, reason: 'That suggestion was already decided.' };
	}
	// The discussion thread goes with the retracted suggestion - but never
	// someone else's words: once others have replied on it, the suggestion
	// stays and gets decided instead. Checked under the thread's row lock
	// (addComment takes the same lock) so a reply cannot land between the
	// check and the delete.
	//
	// The suggestion is locked before its thread, the order clearReviews takes
	// them in, so the two cannot deadlock.
	return await db.transaction(async (tx) => {
		const [locked] = await tx
			.select({ status: reviewSuggestions.status })
			.from(reviewSuggestions)
			.where(eq(reviewSuggestions.id, suggestionId))
			.for('update');
		if (!locked) return { ok: false, reason: 'That suggestion does not exist.' };
		if (locked.status !== 'pending') {
			return { ok: false, reason: 'That suggestion was already decided.' };
		}
		const [thread] = await tx
			.select({ id: reviewThreads.id })
			.from(reviewThreads)
			.where(eq(reviewThreads.suggestionId, suggestionId))
			.for('update');
		if (thread) {
			const discussion = await tx
				.select()
				.from(reviewComments)
				.where(eq(reviewComments.threadId, thread.id));
			if (!discussion.every((comment) => ownsComment(comment, actor))) {
				return { ok: false, reason: 'Others have replied on it; it can only be decided now.' };
			}
			await tx.delete(reviewComments).where(eq(reviewComments.threadId, thread.id));
			await tx.delete(reviewThreads).where(eq(reviewThreads.id, thread.id));
		}
		await tx
			.delete(reviewSuggestions)
			.where(and(eq(reviewSuggestions.id, suggestionId), eq(reviewSuggestions.status, 'pending')));
		return { ok: true };
	});
}

export type ClearScope = 'finished' | 'all';

// What a page load counts as seen for "Clear review notes": notes stamped
// before this moment. Read from the database clock, which stamps each note's
// created_at, to the microsecond, so a note written in the same millisecond is
// still told apart; it is compared in SQL for the same reason.
//
// A note stamped inside a transaction that has not committed yet is not on
// the page, so the cutoff goes back to the start of the oldest open
// transaction: anything such a transaction writes is stamped after that.
export async function reviewSeenCutoff(db: Database): Promise<string> {
	const { rows } = await db.execute<{ at: string }>(
		sql`select to_char(
			least(
				now(),
				(select min(xact_start) from pg_stat_activity
					where datname = current_database() and pid <> pg_backend_pid())
			) at time zone 'UTC',
			'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
		) as at`
	);
	return rows[0].at;
}

// Clears the story's review notes in one go. 'finished' takes resolved
// threads and decided suggestions (with their discussions) and keeps
// everything still open; 'all' takes every thread, comment and suggestion.
// Notes on scenes in the deleted list stay with those scenes. Saved drafts
// never hold review notes, so they are not touched.
//
// Only what the writer could have seen goes: a thread or suggestion created
// after `seenBefore` (when their page loaded), or one with a reply posted
// since, is kept, so a guest's new note is never cleared unread. Notes are
// stamped when written (clock_timestamp), after their thread lock, and the
// cutoff allows for notes still being committed (see reviewSeenCutoff).
//
// Suggestions are locked before threads: a first reply on a suggestion
// creates its thread, and that insert waits on the suggestion lock, so no
// discussion thread can appear unseen. Threads are then locked the way
// addComment locks them, so no reply lands in a thread being deleted.
export async function clearReviews(
	db: Database,
	storyId: string,
	scope: ClearScope,
	seenBefore: string
): Promise<void> {
	const after = (column: AnyColumn) => sql<boolean>`${column} > ${seenBefore}::timestamptz`;
	await db.transaction(async (tx) => {
		const liveScene = sql`(select ${scenes.id} from ${scenes} where ${scenes.storyId} = ${storyId} and ${scenes.deletedAt} is null)`;
		const suggestions = await tx
			.select({
				id: reviewSuggestions.id,
				status: reviewSuggestions.status,
				fresh: after(reviewSuggestions.createdAt)
			})
			.from(reviewSuggestions)
			.where(
				and(eq(reviewSuggestions.storyId, storyId), inArray(reviewSuggestions.sceneId, liveScene))
			)
			.for('update');
		const threads = await tx
			.select({
				id: reviewThreads.id,
				resolvedAt: reviewThreads.resolvedAt,
				suggestionId: reviewThreads.suggestionId,
				fresh: after(reviewThreads.createdAt)
			})
			.from(reviewThreads)
			.where(and(eq(reviewThreads.storyId, storyId), inArray(reviewThreads.sceneId, liveScene)))
			.for('update');
		// The thread locks hold back new replies, so this read is final.
		const replied =
			threads.length === 0
				? []
				: await tx
						.selectDistinct({ threadId: reviewComments.threadId })
						.from(reviewComments)
						.where(
							and(
								inArray(
									reviewComments.threadId,
									threads.map((thread) => thread.id)
								),
								after(reviewComments.createdAt)
							)
						);
		const newSince = new Set(replied.map((row) => row.threadId));
		for (const thread of threads) {
			if (thread.fresh) newSince.add(thread.id);
		}
		const discussed = new Map(
			threads
				.filter((thread) => thread.suggestionId)
				.map((thread) => [thread.suggestionId!, thread.id])
		);
		const goingSuggestions = suggestions
			.filter((suggestion) => scope === 'all' || suggestion.status !== 'pending')
			.filter((suggestion) => !suggestion.fresh)
			.filter((suggestion) => !newSince.has(discussed.get(suggestion.id) ?? ''))
			.map((suggestion) => suggestion.id);
		const going = new Set(goingSuggestions);
		const goingThreads = threads
			.filter((thread) =>
				thread.suggestionId
					? going.has(thread.suggestionId)
					: (scope === 'all' || thread.resolvedAt !== null) && !newSince.has(thread.id)
			)
			.map((thread) => thread.id);
		if (goingThreads.length > 0) {
			await tx.delete(reviewComments).where(inArray(reviewComments.threadId, goingThreads));
			await tx.delete(reviewThreads).where(inArray(reviewThreads.id, goingThreads));
		}
		if (goingSuggestions.length > 0) {
			await tx.delete(reviewSuggestions).where(inArray(reviewSuggestions.id, goingSuggestions));
		}
	});
}
