import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, eq } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	reviewers as reviewersTable,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import { reanchorRange } from '../../src/lib/review-anchor';
import { deleteStory } from '../../src/lib/server/story-delete';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

// Challenge and reviewer cookies are signed with APP_SECRET.
process.env.APP_SECRET = process.env.APP_SECRET || 'review-test-secret';

const {
	addComment,
	createReviewInvitation,
	createThread,
	deleteComment,
	ensureReviewer,
	invitationByToken,
	issueReviewerToken,
	listReviewInvitations,
	listThreads,
	readReviewerToken,
	reviewerAccess,
	revokeReviewInvitation,
	setThreadResolved
} = await import('../../src/lib/server/review');

let pool: pg.Pool;
let db: Database;
let authorId: string;
let strangerId: string;
let storyId: string;
let sceneId: string;

const BODY = 'The quick brown fox jumps over the lazy dog.';

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query(
		'truncate table review_comments, review_threads, reviewers, review_invitations, revisions, scenes, chapters, stories, universes, users cascade'
	);
	const [author] = await db
		.insert(users)
		.values({ email: 'a@example.com', displayName: 'Avery', passwordHash: 'x', role: 'user' })
		.returning({ id: users.id });
	authorId = author.id;
	const [stranger] = await db
		.insert(users)
		.values({ email: 's@example.com', displayName: 'Sam', passwordHash: 'x', role: 'user' })
		.returning({ id: users.id });
	strangerId = stranger.id;
	const [universe] = await db
		.insert(universes)
		.values({ ownerId: authorId, name: 'U' })
		.returning({ id: universes.id });
	const [story] = await db
		.insert(stories)
		.values({ universeId: universe.id, ownerId: authorId, title: 'S' })
		.returning({ id: stories.id });
	storyId = story.id;
	const [scene] = await db
		.insert(scenes)
		.values({ storyId, globalPosition: 1, bodyMd: BODY })
		.returning({ id: scenes.id });
	sceneId = scene.id;
});

afterAll(async () => {
	await pool.end();
});

async function invite() {
	return await createReviewInvitation(db, { storyId, createdBy: authorId });
}

async function guest(invitationId: string, name = 'Robin') {
	const reviewer = await ensureReviewer(db, invitationId, { displayName: name });
	if (!reviewer) throw new Error('no reviewer');
	return reviewer;
}

describe('invitations', () => {
	it('stores only the token hash and resolves the raw token', async () => {
		const { id, token } = await invite();
		const [listed] = await listReviewInvitations(db, storyId);
		expect(listed.id).toBe(id);
		expect(listed.tokenHash).not.toContain(token);

		const resolved = await invitationByToken(db, token);
		expect(resolved.status).toBe('ok');
		if (resolved.status === 'ok') expect(resolved.invitation.id).toBe(id);
		expect((await invitationByToken(db, 'wrong-token')).status).toBe('unknown');
	});

	it('reports revoked and expired links distinctly', async () => {
		const { id, token } = await invite();
		expect(await revokeReviewInvitation(db, strangerId, id)).toBe(false);
		expect(await revokeReviewInvitation(db, authorId, id)).toBe(true);
		expect((await invitationByToken(db, token)).status).toBe('revoked');

		const expired = await createReviewInvitation(db, {
			storyId,
			createdBy: authorId,
			expiresAt: new Date(Date.now() - 1000)
		});
		expect((await invitationByToken(db, expired.token)).status).toBe('expired');
	});
});

describe('reviewers', () => {
	it('creates a guest identity and reuses a user identity per invitation', async () => {
		const { id } = await invite();
		const robin = await guest(id);
		expect(robin.displayName).toBe('Robin');
		expect(await ensureReviewer(db, id, { displayName: '   ' })).toBeNull();

		const first = await ensureReviewer(db, id, { userId: strangerId, displayName: 'Sam' });
		const second = await ensureReviewer(db, id, { userId: strangerId, displayName: 'Sam' });
		expect(first!.id).toBe(second!.id);
	});

	it('concurrent first requests settle on one reviewer row per user', async () => {
		const { id } = await invite();
		// Without the unique index and upsert, both of these could insert,
		// splitting attribution and the mine/retract checks.
		const rows = await Promise.all([
			ensureReviewer(db, id, { userId: strangerId, displayName: 'Sam' }),
			ensureReviewer(db, id, { userId: strangerId, displayName: 'Sam' })
		]);
		expect(rows[0]!.id).toBe(rows[1]!.id);
		const stored = await db
			.select()
			.from(reviewersTable)
			.where(and(eq(reviewersTable.invitationId, id), eq(reviewersTable.userId, strangerId)));
		expect(stored).toHaveLength(1);
	});

	it('round-trips the reviewer cookie and refuses tampering', async () => {
		const { id } = await invite();
		const robin = await guest(id);
		const token = issueReviewerToken(robin.id);
		expect(readReviewerToken(token)).toBe(robin.id);
		expect(readReviewerToken(token.slice(0, -2))).toBeNull();
		expect(readReviewerToken(undefined)).toBeNull();
	});

	it('grants access only while the invitation stands', async () => {
		const { id } = await invite();
		const robin = await guest(id);
		expect(await reviewerAccess(db, robin.id, storyId)).not.toBeNull();
		// The wrong story is out of scope.
		expect(await reviewerAccess(db, robin.id, crypto.randomUUID())).toBeNull();
		await revokeReviewInvitation(db, authorId, id);
		expect(await reviewerAccess(db, robin.id, storyId)).toBeNull();
	});
});

describe('threads and comments', () => {
	it('opens an anchored thread pinned to a base revision and lists it', async () => {
		const { id } = await invite();
		const robin = await guest(id);
		const start = BODY.indexOf('brown');
		const end = start + 'brown fox'.length;
		const created = await createThread(db, {
			storyId,
			sceneId,
			anchor: { start, end },
			author: { reviewerId: robin.id },
			body: 'Is the fox brown everywhere?'
		});
		expect(created).toMatchObject({ ok: true });

		const [thread] = await listThreads(db, storyId, reanchorRange);
		expect(thread.anchor).toEqual({ start, end });
		expect(thread.anchorLost).toBe(false);
		expect(thread.comments).toHaveLength(1);
		expect(thread.comments[0].authorName).toBe('Robin');
		expect(thread.comments[0].isOwner).toBe(false);
	});

	it('re-anchors after edits and flags a destroyed range', async () => {
		const { id } = await invite();
		const robin = await guest(id);
		const start = BODY.indexOf('brown');
		await createThread(db, {
			storyId,
			sceneId,
			anchor: { start, end: start + 'brown fox'.length },
			author: { reviewerId: robin.id },
			body: 'Anchor me.'
		});

		// An edit before the range shifts the anchor.
		await db
			.update(scenes)
			.set({ bodyMd: 'Lo! ' + BODY })
			.where(eq(scenes.id, sceneId));
		let [thread] = await listThreads(db, storyId, reanchorRange);
		expect(thread.anchor).toEqual({ start: start + 4, end: start + 4 + 'brown fox'.length });

		// Rewriting the commented words loses it.
		await db
			.update(scenes)
			.set({ bodyMd: BODY.replace('brown fox', 'red vixen') })
			.where(eq(scenes.id, sceneId));
		[thread] = await listThreads(db, storyId, reanchorRange);
		expect(thread.anchor).toBeNull();
		expect(thread.anchorLost).toBe(true);
	});

	it('supports whole-scene threads, replies, and owner-only resolution', async () => {
		const { id } = await invite();
		const robin = await guest(id);
		const created = await createThread(db, {
			storyId,
			sceneId,
			anchor: null,
			author: { reviewerId: robin.id },
			body: 'Lovely scene.'
		});
		if (!created.ok) throw new Error('thread not created');

		expect(
			await addComment(db, {
				storyId,
				threadId: created.threadId,
				author: { userId: authorId },
				body: 'Thank you!'
			})
		).toMatchObject({ ok: true });

		// Only the owner resolves.
		expect(await setThreadResolved(db, strangerId, created.threadId, true)).toBe(false);
		expect(await setThreadResolved(db, authorId, created.threadId, true)).toBe(true);
		const [thread] = await listThreads(db, storyId, reanchorRange);
		expect(thread.resolvedAt).not.toBeNull();
		expect(thread.comments.map((comment) => comment.authorName)).toEqual(['Robin', 'Avery']);
	});

	it('rejects empty bodies, bad anchors, and foreign scenes', async () => {
		const { id } = await invite();
		const robin = await guest(id);
		const author = { reviewerId: robin.id };
		expect(
			await createThread(db, { storyId, sceneId, anchor: null, author, body: '  ' })
		).toMatchObject({ ok: false });
		expect(
			await createThread(db, {
				storyId,
				sceneId,
				anchor: { start: 5, end: 99999 },
				author,
				body: 'x'
			})
		).toMatchObject({ ok: false });
		expect(
			await createThread(db, {
				storyId,
				sceneId: crypto.randomUUID(),
				anchor: null,
				author,
				body: 'x'
			})
		).toMatchObject({ ok: false });
	});
});

describe('deleteComment (retract your own)', () => {
	it('a reviewer retracts their own reply, leaving the root and others', async () => {
		const { id } = await invite();
		const robin = await guest(id);
		const created = await createThread(db, {
			storyId,
			sceneId,
			anchor: null,
			author: { reviewerId: robin.id },
			body: 'Root by Robin.'
		});
		if (!created.ok) throw new Error('no thread');
		await addComment(db, {
			storyId,
			threadId: created.threadId,
			author: { userId: authorId },
			body: 'Author reply.'
		});
		await addComment(db, {
			storyId,
			threadId: created.threadId,
			author: { reviewerId: robin.id },
			body: 'Robin reply.'
		});

		const [before] = await listThreads(db, storyId, reanchorRange, { reviewerId: robin.id });
		const robinReply = before.comments.find((c) => c.body === 'Robin reply.')!;
		expect(robinReply.mine).toBe(true);
		expect(before.comments.find((c) => c.body === 'Author reply.')!.mine).toBe(false);

		expect(await deleteComment(db, { reviewerId: robin.id }, robinReply.id)).toMatchObject({
			ok: true
		});
		const [after] = await listThreads(db, storyId, reanchorRange, { reviewerId: robin.id });
		expect(after.comments.map((c) => c.body)).toEqual(['Root by Robin.', 'Author reply.']);
	});

	it('retracts the opening comment only when no one else has joined the thread', async () => {
		const { id } = await invite();
		const robin = await guest(id);
		const solo = await createThread(db, {
			storyId,
			sceneId,
			anchor: null,
			author: { reviewerId: robin.id },
			body: 'Solo.'
		});
		if (!solo.ok) throw new Error('no thread');
		const [soloView] = await listThreads(db, storyId, reanchorRange, { reviewerId: robin.id });
		expect(
			await deleteComment(db, { reviewerId: robin.id }, soloView.comments[0].id)
		).toMatchObject({ ok: true });
		expect(await listThreads(db, storyId, reanchorRange)).toEqual([]);

		// A root the author has replied to cannot be retracted; resolve instead.
		const replied = await createThread(db, {
			storyId,
			sceneId,
			anchor: null,
			author: { reviewerId: robin.id },
			body: 'Has a reply.'
		});
		if (!replied.ok) throw new Error('no thread');
		await addComment(db, {
			storyId,
			threadId: replied.threadId,
			author: { userId: authorId },
			body: 'Replying.'
		});
		const [withReply] = await listThreads(db, storyId, reanchorRange, { reviewerId: robin.id });
		expect(
			await deleteComment(db, { reviewerId: robin.id }, withReply.comments[0].id)
		).toMatchObject({ ok: false });
		expect((await listThreads(db, storyId, reanchorRange)).length).toBe(1);
	});

	it('refuses to delete a comment the actor did not write', async () => {
		const { id } = await invite();
		const robin = await guest(id);
		const created = await createThread(db, {
			storyId,
			sceneId,
			anchor: null,
			author: { userId: authorId },
			body: 'Author root.'
		});
		if (!created.ok) throw new Error('no thread');
		const [thread] = await listThreads(db, storyId, reanchorRange);
		expect(await deleteComment(db, { reviewerId: robin.id }, thread.comments[0].id)).toMatchObject({
			ok: false
		});
		expect(await deleteComment(db, { userId: strangerId }, thread.comments[0].id)).toMatchObject({
			ok: false
		});
		expect((await listThreads(db, storyId, reanchorRange)).length).toBe(1);
	});
});

describe('lifecycle', () => {
	it('deleting the story removes invitations, reviewers, threads, and comments', async () => {
		const { id } = await invite();
		const robin = await guest(id);
		await createThread(db, {
			storyId,
			sceneId,
			anchor: null,
			author: { reviewerId: robin.id },
			body: 'Going with the story.'
		});
		expect(await deleteStory(db, storyId, authorId)).toBe(true);
		expect(await listReviewInvitations(db, storyId)).toEqual([]);
		expect(
			await db.select().from(reviewersTable).where(eq(reviewersTable.invitationId, id))
		).toEqual([]);
	});
});

describe('guest reviewer emails', () => {
	it('stores a plausible email on join and drops a junk one', async () => {
		const { id: invitationId } = await invite();
		const withEmail = await ensureReviewer(db, invitationId, {
			displayName: 'Maren',
			email: ' Maren@Example.com '
		});
		expect(withEmail?.email).toBe('maren@example.com');

		const withJunk = await ensureReviewer(db, invitationId, {
			displayName: 'Bram',
			email: 'not-an-email'
		});
		expect(withJunk?.email).toBeNull();

		const without = await ensureReviewer(db, invitationId, { displayName: 'Quiet' });
		expect(without?.email).toBeNull();
	});
});
