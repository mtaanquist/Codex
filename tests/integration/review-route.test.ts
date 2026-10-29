import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type pg from 'pg';
import {
	reviewers,
	reviewSuggestions,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase } from './test-db';

// The guest review page's actions, called as the real handlers with a
// reviewer cookie, against the test database.

process.env.APP_SECRET = process.env.APP_SECRET || 'review-test-secret';

vi.mock('#lib/server/db', async () => {
	const { default: pgModule } = await import('pg');
	const { drizzle } = await import('drizzle-orm/node-postgres');
	const schemaModule = await import('../../src/lib/server/db/schema');
	const { TEST_DATABASE_URL } = await import('./test-db');
	const testPool = new pgModule.Pool({ connectionString: TEST_DATABASE_URL });
	return { db: drizzle(testPool, { schema: schemaModule }), pool: testPool };
});
vi.mock('#lib/server/notify', () => ({ notifyReviewActivity: vi.fn(async () => undefined) }));

const { db, pool } = (await import('#lib/server/db')) as unknown as {
	db: Database;
	pool: pg.Pool;
};
const { resetRateLimits } = await import('#lib/server/rate-limit');
const { createReviewInvitation, ensureReviewer, issueReviewerToken } =
	await import('../../src/lib/server/review');
const page = await import('../../src/routes/review/[token]/+page.server');

const BODY = 'The quick brown fox jumps over the lazy dog.';

let authorId: string;
let storyId: string;
let sceneId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query('truncate table users cascade');
	resetRateLimits();
	const [author] = await db
		.insert(users)
		.values({ email: 'a@example.com', displayName: 'Avery', passwordHash: 'x', role: 'user' })
		.returning({ id: users.id });
	authorId = author.id;
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

function event(token: string, cookie: string | undefined, form: FormData, ip = '127.0.0.1') {
	const url = new URL(`http://localhost/review/${token}`);
	return {
		params: { token },
		url,
		request: new Request(url, { method: 'POST', body: form }),
		locals: { user: null, session: null },
		cookies: { get: vi.fn(() => cookie), set: vi.fn(), delete: vi.fn(), getAll: vi.fn(() => []) },
		getClientAddress: () => ip
	} as unknown as Parameters<NonNullable<typeof page.actions.suggest>>[0];
}

function suggestForm() {
	const form = new FormData();
	form.set('sceneId', sceneId);
	form.set('start', '4');
	form.set('end', '9');
	form.set('replacement', 'slow');
	return form;
}

describe('suggest action', () => {
	it('follows the link in the URL, not the invitation the cookie was issued under', async () => {
		const commentOnly = await createReviewInvitation(db, {
			storyId,
			createdBy: authorId,
			canSuggest: false
		});
		const withSuggestions = await createReviewInvitation(db, {
			storyId,
			createdBy: authorId,
			canSuggest: true
		});
		const reviewer = await ensureReviewer(db, commentOnly.id, { displayName: 'Robin' });
		const cookie = issueReviewerToken(reviewer!.id);

		const result = await page.actions.suggest(event(withSuggestions.token, cookie, suggestForm()));
		expect(result).toEqual({ suggested: true });
		expect(await db.select().from(reviewSuggestions)).toHaveLength(1);
	});

	it('refuses a suggestion through a comment-only link', async () => {
		const withSuggestions = await createReviewInvitation(db, {
			storyId,
			createdBy: authorId,
			canSuggest: true
		});
		const commentOnly = await createReviewInvitation(db, {
			storyId,
			createdBy: authorId,
			canSuggest: false
		});
		const reviewer = await ensureReviewer(db, withSuggestions.id, { displayName: 'Robin' });
		const cookie = issueReviewerToken(reviewer!.id);

		const result = await page.actions.suggest(event(commentOnly.token, cookie, suggestForm()));
		expect(result).toMatchObject({ status: 403 });
		expect(await db.select().from(reviewSuggestions)).toHaveLength(0);
	});
});

describe('comment action limit', () => {
	function commentForm() {
		const form = new FormData();
		form.set('sceneId', sceneId);
		form.set('body', 'A note.');
		return form;
	}

	it('refuses the 31st comment from one reviewer, not from another', async () => {
		const invitation = await createReviewInvitation(db, { storyId, createdBy: authorId });
		const first = await ensureReviewer(db, invitation.id, { displayName: 'Robin' });
		const second = await ensureReviewer(db, invitation.id, { displayName: 'Sam' });
		const cookie = issueReviewerToken(first!.id);

		for (let i = 0; i < 30; i++) {
			const result = await page.actions.comment(event(invitation.token, cookie, commentForm()));
			expect(result).toEqual({ commented: true });
		}
		const refused = await page.actions.comment(event(invitation.token, cookie, commentForm()));
		expect(refused).toMatchObject({ status: 429 });

		const other = await page.actions.comment(
			event(invitation.token, issueReviewerToken(second!.id), commentForm())
		);
		expect(other).toEqual({ commented: true });
	});
});

describe('join action limit', () => {
	function joinForm() {
		const form = new FormData();
		form.set('displayName', 'Robin');
		return form;
	}

	// Each join makes a new reviewer with its own comment budget, so joining
	// is limited per client address.
	it('refuses the 11th join from one address, not from another', async () => {
		const invitation = await createReviewInvitation(db, { storyId, createdBy: authorId });
		for (let i = 0; i < 10; i++) {
			const result = await page.actions.join(
				event(invitation.token, undefined, joinForm(), '198.51.100.7')
			);
			expect(result).toEqual({ joined: true });
		}
		const refused = await page.actions.join(
			event(invitation.token, undefined, joinForm(), '198.51.100.7')
		);
		expect(refused).toMatchObject({ status: 429 });
		expect(await db.select().from(reviewers)).toHaveLength(10);

		const other = await page.actions.join(
			event(invitation.token, undefined, joinForm(), '192.0.2.200')
		);
		expect(other).toEqual({ joined: true });
	});
});
