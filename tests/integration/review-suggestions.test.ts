import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, desc, eq } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	reviewSuggestions,
	revisions,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import { deleteStory } from '../../src/lib/server/story-delete';
import { recordRevision } from '../../src/lib/server/revisions';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

process.env.APP_SECRET = process.env.APP_SECRET || 'review-test-secret';

const {
	acceptAllInScene,
	createReviewInvitation,
	createSuggestion,
	decideSuggestion,
	deleteSuggestion,
	ensureReviewer,
	listSuggestions
} = await import('../../src/lib/server/review');

let pool: pg.Pool;
let db: Database;
let authorId: string;
let strangerId: string;
let storyId: string;
let sceneId: string;
let reviewerId: string;

const BODY = 'The quick brown fox jumps over the lazy dog.';

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query(
		'truncate table review_suggestions, review_comments, review_threads, reviewers, review_invitations, revisions, scenes, chapters, stories, universes, users cascade'
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
	const invitation = await createReviewInvitation(db, { storyId, createdBy: authorId });
	const reviewer = await ensureReviewer(db, invitation.id, { displayName: 'Robin' });
	reviewerId = reviewer!.id;
});

afterAll(async () => {
	await pool.end();
});

async function suggest(range: { start: number; end: number }, replacement: string) {
	return await createSuggestion(db, {
		storyId,
		sceneId,
		author: { reviewerId },
		range,
		replacement
	});
}

async function sceneBody(): Promise<string> {
	const [row] = await db
		.select({ bodyMd: scenes.bodyMd })
		.from(scenes)
		.where(eq(scenes.id, sceneId));
	return row.bodyMd;
}

describe('base revision protection', () => {
	it('does not coalesce an autosave that a suggestion pinned as its base', async () => {
		const start = BODY.indexOf('quick');
		const made = await suggest({ start, end: start + 5 }, 'swift');
		expect(made).toMatchObject({ ok: true });
		const [pinned] = await db
			.select({ baseRevisionId: reviewSuggestions.baseRevisionId })
			.from(reviewSuggestions)
			.where(eq(reviewSuggestions.id, (made as { suggestionId: string }).suggestionId));

		const before = await db.select().from(revisions).where(eq(revisions.entityId, sceneId));
		// An autosave inside the coalesce window would normally roll the latest
		// autosave row forward; the pinned base must be left intact, so this
		// appends a new revision instead.
		await recordRevision(db, 'scene', sceneId, `${BODY} The fox rests.`, 'autosave');

		const [base] = await db
			.select({ bodyMd: revisions.bodyMd })
			.from(revisions)
			.where(eq(revisions.id, pinned.baseRevisionId!));
		expect(base.bodyMd).toBe(BODY);
		const after = await db.select().from(revisions).where(eq(revisions.entityId, sceneId));
		expect(after.length).toBe(before.length + 1);
	});
});

describe('author-authored suggestions', () => {
	it('attributes the author and marks it as theirs', async () => {
		const start = BODY.indexOf('lazy dog');
		const result = await createSuggestion(db, {
			storyId,
			sceneId,
			author: { userId: authorId },
			range: { start, end: start + 'lazy dog'.length },
			replacement: 'sleeping cat'
		});
		expect(result).toMatchObject({ ok: true });
		const [view] = await listSuggestions(db, storyId);
		expect(view.isOwner).toBe(true);
		expect(view.reviewerName).toBe('Avery');
		// A guest's suggestion is not flagged as the owner's.
		const guestStart = BODY.indexOf('brown fox');
		await suggest({ start: guestStart, end: guestStart + 'brown fox'.length }, 'red vixen');
		const views = await listSuggestions(db, storyId);
		expect(views.find((v) => v.replacement === 'red vixen')?.isOwner).toBe(false);
	});
});

describe('createSuggestion', () => {
	it('records a replacement pinned to a base revision', async () => {
		const start = BODY.indexOf('brown fox');
		const result = await suggest({ start, end: start + 'brown fox'.length }, 'red vixen');
		expect(result).toMatchObject({ ok: true });
		const [view] = await listSuggestions(db, storyId);
		expect(view.original).toBe('brown fox');
		expect(view.replacement).toBe('red vixen');
		expect(view.status).toBe('pending');
		expect(view.reviewerName).toBe('Robin');
		expect(view.anchor).toEqual({ start, end: start + 'brown fox'.length });
	});

	it('rejects no-ops and bad ranges', async () => {
		const start = BODY.indexOf('brown');
		expect(await suggest({ start, end: start + 5 }, 'brown')).toMatchObject({ ok: false });
		expect(await suggest({ start: 5, end: 99999 }, 'x')).toMatchObject({ ok: false });
		expect(await suggest({ start: 9, end: 5 }, 'x')).toMatchObject({ ok: false });
	});
});

describe('decideSuggestion', () => {
	it('accept applies the replacement, records a revision, and is final', async () => {
		const start = BODY.indexOf('brown fox');
		const { suggestionId } = (await suggest(
			{ start, end: start + 'brown fox'.length },
			'red vixen'
		)) as { ok: true; suggestionId: string };

		const result = await decideSuggestion(db, authorId, suggestionId, true);
		expect(result).toMatchObject({ ok: true, sceneId });
		expect(await sceneBody()).toBe(BODY.replace('brown fox', 'red vixen'));

		const [latest] = await db
			.select({ reason: revisions.reason })
			.from(revisions)
			.where(and(eq(revisions.entityType, 'scene'), eq(revisions.entityId, sceneId)))
			.orderBy(desc(revisions.createdAt))
			.limit(1);
		expect(latest.reason).toBe('suggestion');

		const [view] = await listSuggestions(db, storyId);
		expect(view.status).toBe('accepted');
		// A second decision is refused.
		expect(await decideSuggestion(db, authorId, suggestionId, false)).toMatchObject({ ok: false });
	});

	it('applies at the re-anchored position after edits elsewhere', async () => {
		const start = BODY.indexOf('brown fox');
		const { suggestionId } = (await suggest(
			{ start, end: start + 'brown fox'.length },
			'red vixen'
		)) as { ok: true; suggestionId: string };
		// The author edits before the range; the suggestion still lands right.
		await db
			.update(scenes)
			.set({ bodyMd: 'Lo! ' + BODY })
			.where(eq(scenes.id, sceneId));

		expect(await decideSuggestion(db, authorId, suggestionId, true)).toMatchObject({ ok: true });
		expect(await sceneBody()).toBe('Lo! ' + BODY.replace('brown fox', 'red vixen'));
	});

	it('refuses to accept once the passage was rewritten, but can reject', async () => {
		const start = BODY.indexOf('brown fox');
		const { suggestionId } = (await suggest(
			{ start, end: start + 'brown fox'.length },
			'red vixen'
		)) as { ok: true; suggestionId: string };
		await db
			.update(scenes)
			.set({ bodyMd: BODY.replace('brown fox', 'silver wolf') })
			.where(eq(scenes.id, sceneId));

		const [view] = await listSuggestions(db, storyId);
		expect(view.anchorLost).toBe(true);
		expect(await decideSuggestion(db, authorId, suggestionId, true)).toMatchObject({
			ok: false,
			reason: expect.stringContaining('has changed')
		});
		expect(await decideSuggestion(db, authorId, suggestionId, false)).toMatchObject({ ok: true });
	});

	it('handles pure insertions and pure deletions', async () => {
		const insertAt = BODY.indexOf('jumps');
		const insertion = (await suggest({ start: insertAt, end: insertAt }, 'nimbly ')) as {
			ok: true;
			suggestionId: string;
		};
		expect(await decideSuggestion(db, authorId, insertion.suggestionId, true)).toMatchObject({
			ok: true
		});
		expect(await sceneBody()).toContain('nimbly jumps');

		const current = await sceneBody();
		const delStart = current.indexOf(' over the lazy');
		const deletion = (await suggest(
			{ start: delStart, end: delStart + ' over the lazy dog'.length },
			''
		)) as { ok: true; suggestionId: string };
		expect(await decideSuggestion(db, authorId, deletion.suggestionId, true)).toMatchObject({
			ok: true
		});
		expect(await sceneBody()).not.toContain('lazy dog');
	});

	it('only the owner decides', async () => {
		const start = BODY.indexOf('quick');
		const { suggestionId } = (await suggest({ start, end: start + 5 }, 'swift')) as {
			ok: true;
			suggestionId: string;
		};
		expect(await decideSuggestion(db, strangerId, suggestionId, true)).toMatchObject({
			ok: false
		});
		expect(await sceneBody()).toBe(BODY);
	});
});

describe('deleteSuggestion (retract your own pending edit)', () => {
	it('a reviewer retracts their own pending suggestion and flags it as theirs', async () => {
		const start = BODY.indexOf('brown fox');
		const made = (await suggest({ start, end: start + 'brown fox'.length }, 'red vixen')) as {
			ok: true;
			suggestionId: string;
		};
		// The mine flag follows whoever is viewing.
		const [asReviewer] = await listSuggestions(db, storyId, { reviewerId });
		expect(asReviewer.mine).toBe(true);
		const [asAuthor] = await listSuggestions(db, storyId, { userId: authorId });
		expect(asAuthor.mine).toBe(false);

		expect(await deleteSuggestion(db, { reviewerId }, made.suggestionId)).toMatchObject({
			ok: true
		});
		expect(await listSuggestions(db, storyId)).toEqual([]);
	});

	it('refuses to delete a foreign suggestion or a decided one', async () => {
		const start = BODY.indexOf('brown fox');
		const made = (await suggest({ start, end: start + 'brown fox'.length }, 'red vixen')) as {
			ok: true;
			suggestionId: string;
		};
		// The author did not write the guest's suggestion.
		expect(await deleteSuggestion(db, { userId: authorId }, made.suggestionId)).toMatchObject({
			ok: false
		});
		// Once decided, even its own author can no longer retract it.
		const lazy = BODY.indexOf('lazy');
		const own = (await createSuggestion(db, {
			storyId,
			sceneId,
			author: { userId: authorId },
			range: { start: lazy, end: lazy + 4 },
			replacement: 'happy'
		})) as { ok: true; suggestionId: string };
		await decideSuggestion(db, authorId, own.suggestionId, false);
		expect(await deleteSuggestion(db, { userId: authorId }, own.suggestionId)).toMatchObject({
			ok: false
		});
	});
});

describe('acceptAllInScene', () => {
	it('accepts every pending suggestion in the scene, reporting the applied ids in order', async () => {
		const quick = BODY.indexOf('quick');
		const first = (await suggest({ start: quick, end: quick + 5 }, 'swift')) as {
			suggestionId: string;
		};
		const lazy = BODY.indexOf('lazy');
		const second = (await suggest({ start: lazy, end: lazy + 4 }, 'sleepy')) as {
			suggestionId: string;
		};

		expect(await acceptAllInScene(db, authorId, storyId, sceneId)).toEqual({
			accepted: 2,
			failed: 0,
			acceptedIds: [first.suggestionId, second.suggestionId]
		});
		const body = await sceneBody();
		expect(body).toContain('swift');
		expect(body).toContain('sleepy');
		expect((await listSuggestions(db, storyId)).every((s) => s.status === 'accepted')).toBe(true);
	});

	it('counts a suggestion whose passage was rewritten as failed, applying the rest', async () => {
		const quick = BODY.indexOf('quick');
		const applied = (await suggest({ start: quick, end: quick + 5 }, 'swift')) as {
			suggestionId: string;
		};
		const fox = BODY.indexOf('brown fox');
		await suggest({ start: fox, end: fox + 'brown fox'.length }, 'red vixen');
		// The author rewrites the second suggestion's passage out from under it.
		await db
			.update(scenes)
			.set({ bodyMd: BODY.replace('brown fox', 'green hare') })
			.where(eq(scenes.id, sceneId));

		const result = await acceptAllInScene(db, authorId, storyId, sceneId);
		expect(result.accepted).toBe(1);
		expect(result.failed).toBe(1);
		expect(result.acceptedIds).toEqual([applied.suggestionId]);
		expect(await sceneBody()).toContain('swift');
	});
});

describe('lifecycle', () => {
	it('deleting the story removes its suggestions', async () => {
		const start = BODY.indexOf('quick');
		await suggest({ start, end: start + 5 }, 'swift');
		expect(await deleteStory(db, storyId, authorId)).toBe(true);
		expect(await listSuggestions(db, storyId)).toEqual([]);
	});
});
