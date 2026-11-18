import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	reviewComments,
	reviewSuggestions,
	reviewThreads,
	scenes,
	stories,
	storyDrafts,
	universes,
	users
} from '../../src/lib/server/db/schema';
import { saveDraft } from '../../src/lib/server/story-drafts';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

process.env.APP_SECRET = process.env.APP_SECRET || 'review-test-secret';

const {
	addComment,
	clearReviews,
	databaseNow,
	createReviewInvitation,
	createSuggestion,
	createThread,
	decideSuggestion,
	ensureReviewer,
	ensureSuggestionThread,
	setThreadResolved
} = await import('../../src/lib/server/review');

let pool: pg.Pool;
let db: Database;
let authorId: string;
let storyId: string;
let otherStoryId: string;
let sceneId: string;
let otherSceneId: string;
let reviewerId: string;

const BODY = 'The quick brown fox jumps over the lazy dog.';

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

afterAll(async () => {
	await pool.end();
});

beforeEach(async () => {
	await pool.query(
		'truncate table story_drafts, review_suggestions, review_comments, review_threads, reviewers, review_invitations, revisions, scenes, chapters, stories, universes, users cascade'
	);
	const [author] = await db
		.insert(users)
		.values({ email: 'a@example.com', displayName: 'Avery', passwordHash: 'x', role: 'user' })
		.returning({ id: users.id });
	authorId = author.id;
	const [universe] = await db
		.insert(universes)
		.values({ ownerId: authorId, name: 'U' })
		.returning({ id: universes.id });
	const [story, other] = await db
		.insert(stories)
		.values([
			{ universeId: universe.id, ownerId: authorId, title: 'S', slug: 's' },
			{ universeId: universe.id, ownerId: authorId, title: 'T', slug: 't' }
		])
		.returning({ id: stories.id });
	storyId = story.id;
	otherStoryId = other.id;
	const [scene, otherScene] = await db
		.insert(scenes)
		.values([
			{ storyId, globalPosition: 1, bodyMd: BODY },
			{ storyId: otherStoryId, globalPosition: 1, bodyMd: BODY }
		])
		.returning({ id: scenes.id });
	sceneId = scene.id;
	otherSceneId = otherScene.id;
	const invitation = await createReviewInvitation(db, { storyId, createdBy: authorId });
	const reviewer = await ensureReviewer(db, invitation.id, { displayName: 'Robin' });
	reviewerId = reviewer!.id;
});

async function thread(story = storyId, scene = sceneId, body = 'A note.') {
	const made = await createThread(db, {
		storyId: story,
		sceneId: scene,
		anchor: null,
		author: { userId: authorId },
		body
	});
	if (!made.ok) throw new Error(made.reason);
	return made.threadId;
}

async function suggestion(word: string) {
	const start = BODY.indexOf(word);
	const made = await createSuggestion(db, {
		storyId,
		sceneId,
		author: { reviewerId },
		range: { start, end: start + word.length },
		replacement: word.toUpperCase()
	});
	if (!made.ok) throw new Error(made.reason);
	return made.suggestionId;
}

// One of each: an open thread, a resolved thread, a pending suggestion with
// a discussion, a rejected suggestion with a discussion, and a thread on
// another story.
async function seed() {
	const open = await thread();
	const resolved = await thread(storyId, sceneId, 'Done with this.');
	await setThreadResolved(db, authorId, storyId, resolved, true);
	const pending = await suggestion('quick');
	const rejected = await suggestion('lazy');
	for (const id of [pending, rejected]) {
		const discussion = await ensureSuggestionThread(db, { storyId, suggestionId: id });
		if (!discussion.ok) throw new Error(discussion.reason);
		await addComment(db, {
			storyId,
			threadId: discussion.threadId,
			author: { reviewerId },
			body: 'Why?'
		});
	}
	await decideSuggestion(db, authorId, storyId, rejected, false);
	const elsewhere = await thread(otherStoryId, otherSceneId);
	return { open, resolved, pending, rejected, elsewhere };
}

const threadIds = async () =>
	(await db.select({ id: reviewThreads.id }).from(reviewThreads)).map((row) => row.id).sort();
const suggestionIds = async () =>
	(await db.select({ id: reviewSuggestions.id }).from(reviewSuggestions))
		.map((row) => row.id)
		.sort();

describe('clearReviews', () => {
	it('keeps notes and replies posted after the page was read', async () => {
		const seeded = await seed();
		const seenAt = await databaseNow(db);
		const fresh = await thread(storyId, sceneId, 'Posted since.');
		const late = await suggestion('brown');
		await addComment(db, {
			storyId,
			threadId: seeded.resolved,
			author: { reviewerId },
			body: 'One more thing.'
		});
		const [rejectedThread] = await db
			.select({ id: reviewThreads.id })
			.from(reviewThreads)
			.where(eq(reviewThreads.suggestionId, seeded.rejected));
		await addComment(db, {
			storyId,
			threadId: rejectedThread.id,
			author: { reviewerId },
			body: 'Still think so.'
		});
		await clearReviews(db, storyId, 'all', seenAt);
		const [lateThread] = await db
			.select({ id: reviewThreads.id })
			.from(reviewThreads)
			.where(eq(reviewThreads.suggestionId, late));
		expect(await threadIds()).toEqual(
			[
				seeded.resolved,
				rejectedThread.id,
				fresh,
				seeded.elsewhere,
				...(lateThread ? [lateThread.id] : [])
			].sort()
		);
		expect(await suggestionIds()).toEqual([seeded.rejected, late].sort());
		const kept = await db.select({ body: reviewComments.bodyMd }).from(reviewComments);
		expect(kept.map((row) => row.body)).toEqual(
			expect.arrayContaining(['One more thing.', 'Still think so.', 'Done with this.'])
		);
	});

	it('clears finished notes and keeps open ones', async () => {
		const seeded = await seed();
		const [pendingThread] = await db
			.select({ id: reviewThreads.id })
			.from(reviewThreads)
			.where(eq(reviewThreads.suggestionId, seeded.pending));
		await clearReviews(db, storyId, 'finished', await databaseNow(db));
		expect(await threadIds()).toEqual([seeded.open, pendingThread.id, seeded.elsewhere].sort());
		expect(await suggestionIds()).toEqual([seeded.pending]);
	});

	it('clears everything on the story and nothing on other stories', async () => {
		const seeded = await seed();
		await clearReviews(db, storyId, 'all', await databaseNow(db));
		expect(await threadIds()).toEqual([seeded.elsewhere]);
		expect(await suggestionIds()).toEqual([]);
		const comments = await db.select({ threadId: reviewComments.threadId }).from(reviewComments);
		expect(comments.map((row) => row.threadId)).toEqual([seeded.elsewhere]);
	});

	it('leaves notes on scenes in the deleted list with those scenes', async () => {
		const open = await thread();
		await db.update(scenes).set({ deletedAt: new Date() }).where(eq(scenes.id, sceneId));
		await clearReviews(db, storyId, 'all', await databaseNow(db));
		expect(await threadIds()).toEqual([open]);
	});

	it('leaves saved drafts as they were', async () => {
		await seed();
		const saved = await saveDraft(db, authorId, storyId, { label: 'First draft', note: '' });
		if (!saved.ok) throw new Error(saved.reason);
		const [before] = await db.select().from(storyDrafts);
		await clearReviews(db, storyId, 'all', await databaseNow(db));
		const [after] = await db.select().from(storyDrafts);
		expect(after).toEqual(before);
	});
});
