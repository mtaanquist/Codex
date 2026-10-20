import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { textHash } from '../../src/lib/text-hash';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, desc, eq } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	reviewSuggestions,
	revisions,
	sceneMarkers,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import { deleteStory } from '../../src/lib/server/story-delete';
import { recordRevision } from '../../src/lib/server/revisions';
import { saveSceneBody } from '../../src/lib/server/scene-save';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

process.env.APP_SECRET = process.env.APP_SECRET || 'review-test-secret';

const {
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

describe('assistant suggestions', () => {
	async function assistantSuggest(range: { start: number; end: number }, replacement: string) {
		return await createSuggestion(db, {
			storyId,
			sceneId,
			author: { assistant: true },
			range,
			replacement
		});
	}

	it('drops a repeat of an identical pending suggestion', async () => {
		const start = BODY.indexOf('brown fox');
		const range = { start, end: start + 'brown fox'.length };
		expect(await assistantSuggest(range, 'red vixen')).toMatchObject({ ok: true });
		const repeat = await assistantSuggest(range, 'red vixen');
		expect(repeat).toMatchObject({ ok: false });
		expect((repeat as { reason: string }).reason).toMatch(/already staged/);
		expect(await listSuggestions(db, storyId)).toHaveLength(1);
	});

	it('still stages a different range or replacement, and a repeat after a decision', async () => {
		const start = BODY.indexOf('brown fox');
		const range = { start, end: start + 'brown fox'.length };
		const first = (await assistantSuggest(range, 'red vixen')) as { suggestionId: string };
		expect(await assistantSuggest(range, 'grey wolf')).toMatchObject({ ok: true });
		const lazy = BODY.indexOf('lazy');
		expect(await assistantSuggest({ start: lazy, end: lazy + 4 }, 'red vixen')).toMatchObject({
			ok: true
		});
		// Once the author has decided the first one, the Assistant may propose it
		// again against the text as it now stands.
		await decideSuggestion(db, authorId, storyId, first.suggestionId, false);
		expect(await assistantSuggest(range, 'red vixen')).toMatchObject({ ok: true });
	});

	it('does not dedupe the human paths', async () => {
		const start = BODY.indexOf('brown fox');
		const range = { start, end: start + 'brown fox'.length };
		expect(await suggest(range, 'red vixen')).toMatchObject({ ok: true });
		expect(await suggest(range, 'red vixen')).toMatchObject({ ok: true });
		expect(
			await createSuggestion(db, {
				storyId,
				sceneId,
				author: { userId: authorId },
				range,
				replacement: 'red vixen'
			})
		).toMatchObject({ ok: true });
		expect(await listSuggestions(db, storyId)).toHaveLength(3);
	});
});

describe('decideSuggestion', () => {
	it('accept applies the replacement, records a revision, and is final', async () => {
		const start = BODY.indexOf('brown fox');
		const { suggestionId } = (await suggest(
			{ start, end: start + 'brown fox'.length },
			'red vixen'
		)) as { ok: true; suggestionId: string };

		const result = await decideSuggestion(db, authorId, storyId, suggestionId, true);
		// The editor rebases its save check onto the returned text.
		expect(result).toMatchObject({
			ok: true,
			sceneId,
			bodyMd: BODY.replace('brown fox', 'red vixen'),
			baseHash: textHash(BODY)
		});
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
		expect(await decideSuggestion(db, authorId, storyId, suggestionId, false)).toMatchObject({
			ok: false
		});
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

		expect(await decideSuggestion(db, authorId, storyId, suggestionId, true)).toMatchObject({
			ok: true
		});
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
		expect(await decideSuggestion(db, authorId, storyId, suggestionId, true)).toMatchObject({
			ok: false,
			reason: expect.stringContaining('has changed')
		});
		expect(await decideSuggestion(db, authorId, storyId, suggestionId, false)).toMatchObject({
			ok: true
		});
	});

	it('refuses to accept once the author edited inside the passage', async () => {
		const start = BODY.indexOf('quick brown');
		const { suggestionId } = (await suggest(
			{ start, end: start + 'quick brown'.length },
			'slow'
		)) as { ok: true; suggestionId: string };
		// Both ends of the range survive, but the author added words inside it.
		const edited = BODY.replace('quick brown', 'quick, very brown');
		await db.update(scenes).set({ bodyMd: edited }).where(eq(scenes.id, sceneId));

		const [view] = await listSuggestions(db, storyId);
		expect(view.anchorLost).toBe(true);
		expect(await decideSuggestion(db, authorId, storyId, suggestionId, true)).toMatchObject({
			ok: false,
			reason: expect.stringContaining('has changed')
		});
		expect(await sceneBody()).toBe(edited);
	});

	// A character diff can stretch the mapped range over an insertion right
	// next to it; the passage itself is untouched, so it still applies.
	it.each([
		['She walked in.', 'She slowly walked in.', 'walked in', 'strode in'],
		['She walked in.', 'She was walked in.', 'walked in', 'strode in'],
		['The quick brown fox', 'The quiet quick brown fox', 'quick brown', 'slow']
	])(
		'accepts after an insertion beside the passage (%s -> %s)',
		async (base, edited, target, replacement) => {
			await db.update(scenes).set({ bodyMd: base }).where(eq(scenes.id, sceneId));
			const start = base.indexOf(target);
			const { suggestionId } = (await suggest(
				{ start, end: start + target.length },
				replacement
			)) as { ok: true; suggestionId: string };
			await db.update(scenes).set({ bodyMd: edited }).where(eq(scenes.id, sceneId));

			const [view] = await listSuggestions(db, storyId);
			expect(view.anchorLost).toBe(false);
			expect(edited.slice(view.anchor!.start, view.anchor!.end)).toBe(target);
			expect(await decideSuggestion(db, authorId, storyId, suggestionId, true)).toMatchObject({
				ok: true
			});
			expect(await sceneBody()).toBe(edited.replace(target, replacement));
		}
	);

	it('handles pure insertions and pure deletions', async () => {
		const insertAt = BODY.indexOf('jumps');
		const insertion = (await suggest({ start: insertAt, end: insertAt }, 'nimbly ')) as {
			ok: true;
			suggestionId: string;
		};
		expect(
			await decideSuggestion(db, authorId, storyId, insertion.suggestionId, true)
		).toMatchObject({
			ok: true
		});
		expect(await sceneBody()).toContain('nimbly jumps');

		const current = await sceneBody();
		const delStart = current.indexOf(' over the lazy');
		const deletion = (await suggest(
			{ start: delStart, end: delStart + ' over the lazy dog'.length },
			''
		)) as { ok: true; suggestionId: string };
		expect(
			await decideSuggestion(db, authorId, storyId, deletion.suggestionId, true)
		).toMatchObject({
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
		expect(await decideSuggestion(db, strangerId, storyId, suggestionId, true)).toMatchObject({
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

		expect(await deleteSuggestion(db, { reviewerId }, storyId, made.suggestionId)).toMatchObject({
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
		expect(
			await deleteSuggestion(db, { userId: authorId }, storyId, made.suggestionId)
		).toMatchObject({
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
		await decideSuggestion(db, authorId, storyId, own.suggestionId, false);
		expect(
			await deleteSuggestion(db, { userId: authorId }, storyId, own.suggestionId)
		).toMatchObject({
			ok: false
		});
	});
});

describe('lifecycle', () => {
	it('deleting the story removes its suggestions', async () => {
		const start = BODY.indexOf('quick');
		await suggest({ start, end: start + 5 }, 'swift');
		expect(await deleteStory(db, storyId, authorId)).toBe(true);
		expect(await listSuggestions(db, storyId)).toEqual([]);
	});

	it('does not deadlock against autosaves of the same scene', async () => {
		const start = BODY.indexOf('quick');
		const runs = Array.from({ length: 8 }, (_, i) => [
			saveSceneBody(db, sceneId, {
				title: null,
				bodyMd: `${BODY} ${i}`,
				anchors: null,
				baseHashes: null,
				overwrite: false
			}),
			suggest({ start, end: start + 5 }, `swift ${i}`)
		]).flat();
		const results = await Promise.allSettled(runs);
		expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
	});
});

describe('accepting a suggestion moves marker anchors', () => {
	it('keeps a marker on the same words when text is inserted before it', async () => {
		const phrase = 'lazy dog';
		const start = BODY.indexOf(phrase);
		const [marker] = await db
			.insert(sceneMarkers)
			.values({ sceneId, ownerId: authorId, anchorStart: start, anchorEnd: start + phrase.length })
			.returning({ id: sceneMarkers.id });
		const at = BODY.indexOf('brown');
		const { suggestionId } = (await suggest(
			{ start: at, end: at + 'brown'.length },
			'big brown'
		)) as {
			ok: true;
			suggestionId: string;
		};
		expect(await decideSuggestion(db, authorId, storyId, suggestionId, true)).toMatchObject({
			ok: true
		});
		const body = await sceneBody();
		const [row] = await db.select().from(sceneMarkers).where(eq(sceneMarkers.id, marker.id));
		expect(body.slice(row.anchorStart!, row.anchorEnd!)).toBe(phrase);
	});

	it('keeps a stretched anchor when the suggestion replaces the last marked word', async () => {
		const phrase = 'the lazy dog';
		const start = BODY.indexOf(phrase);
		const [marker] = await db
			.insert(sceneMarkers)
			.values({ sceneId, ownerId: authorId, anchorStart: start, anchorEnd: start + phrase.length })
			.returning({ id: sceneMarkers.id });
		const at = BODY.indexOf('dog');
		const { suggestionId } = (await suggest({ start: at, end: at + 'dog'.length }, 'cat')) as {
			ok: true;
			suggestionId: string;
		};
		expect(await decideSuggestion(db, authorId, storyId, suggestionId, true)).toMatchObject({
			ok: true
		});
		const body = await sceneBody();
		const [row] = await db.select().from(sceneMarkers).where(eq(sceneMarkers.id, marker.id));
		expect(body.slice(row.anchorStart!, row.anchorEnd!)).toBe('the lazy cat');
	});
});
