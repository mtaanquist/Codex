import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, desc, eq } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { revisions, scenes, stories, universes, users } from '../../src/lib/server/db/schema';
import { deleteStory } from '../../src/lib/server/story-delete';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

process.env.APP_SECRET = process.env.APP_SECRET || 'review-test-secret';

const {
	createReviewInvitation,
	createSuggestion,
	decideSuggestion,
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
	return await createSuggestion(db, { storyId, sceneId, reviewerId, range, replacement });
}

async function sceneBody(): Promise<string> {
	const [row] = await db
		.select({ bodyMd: scenes.bodyMd })
		.from(scenes)
		.where(eq(scenes.id, sceneId));
	return row.bodyMd;
}

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

describe('lifecycle', () => {
	it('deleting the story removes its suggestions', async () => {
		const start = BODY.indexOf('quick');
		await suggest({ start, end: start + 5 }, 'swift');
		expect(await deleteStory(db, storyId, authorId)).toBe(true);
		expect(await listSuggestions(db, storyId)).toEqual([]);
	});
});
