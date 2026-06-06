import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	notifications,
	reviewComments,
	reviewers,
	reviewInvitations,
	reviewThreads,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import {
	listNotifications,
	markNotificationsRead,
	notifyAdmins,
	notifyThreadReviewers,
	notifyUsers
} from '../../src/lib/server/notify';
import {
	applyReviewerOptOut,
	buildReviewerDigest,
	buildUserDigest,
	markEmailed,
	markReviewerNotified,
	reviewerOptOutToken
} from '../../src/lib/server/notification-digest';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

// Opt-out tokens are signed with APP_SECRET; any stable value will do here.
process.env.APP_SECRET = process.env.APP_SECRET || 'notifications-test-secret';

let pool: pg.Pool;
let db: Database;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query('truncate table notifications, stories, universes, users cascade');
});

afterAll(async () => {
	await pool.end();
});

async function makeUser(
	email: string,
	options: { role?: 'admin' | 'user'; preferences?: Record<string, unknown> } = {}
) {
	const [user] = await db
		.insert(users)
		.values({
			email,
			displayName: email.split('@')[0],
			passwordHash: 'x',
			role: options.role ?? 'user',
			preferences: options.preferences ?? {}
		})
		.returning();
	return user;
}

describe('notifyUsers', () => {
	it('stamps each row from the recipient preference matrix', async () => {
		const both = await makeUser('both@example.com');
		const noEmail = await makeUser('noemail@example.com', {
			preferences: { notifications: { review_activity: { email: false } } }
		});
		const neither = await makeUser('neither@example.com', {
			preferences: { notifications: { review_activity: { inApp: false, email: false } } }
		});

		await notifyUsers(db, [both.id, noEmail.id, neither.id], 'review_activity', {
			title: 'Maren commented on "Halden"',
			href: '/stories/halden/review'
		});

		const rows = await db.select().from(notifications);
		expect(rows).toHaveLength(2);
		const forBoth = rows.find((row) => row.userId === both.id)!;
		expect(forBoth.inApp).toBe(true);
		expect(forBoth.emailWanted).toBe(true);
		const forNoEmail = rows.find((row) => row.userId === noEmail.id)!;
		expect(forNoEmail.inApp).toBe(true);
		expect(forNoEmail.emailWanted).toBe(false);
		expect(rows.some((row) => row.userId === neither.id)).toBe(false);
	});

	it('notifyAdmins reaches admins only', async () => {
		const admin = await makeUser('boss@example.com', { role: 'admin' });
		await makeUser('writer@example.com');
		await notifyAdmins(db, 'account_pending', { title: 'Someone signed up', href: '/admin' });
		const rows = await db.select().from(notifications);
		expect(rows).toHaveLength(1);
		expect(rows[0].userId).toBe(admin.id);
	});
});

describe('the bell', () => {
	it('lists in-app rows newest first and counts unread, scoped to the user', async () => {
		const me = await makeUser('me@example.com');
		const other = await makeUser('other@example.com');
		await db.insert(notifications).values([
			{ userId: me.id, kind: 'review_activity', payload: { title: 'First' } },
			{ userId: me.id, kind: 'review_activity', payload: { title: 'Hidden' }, inApp: false },
			{ userId: other.id, kind: 'review_activity', payload: { title: 'Not mine' } }
		]);

		const bell = await listNotifications(db, me.id);
		expect(bell.unread).toBe(1);
		expect(bell.items.map((item) => item.title)).toEqual(['First']);

		await markNotificationsRead(db, me.id, [bell.items[0].id]);
		expect((await listNotifications(db, me.id)).unread).toBe(0);
		// The other user's row was untouched.
		expect((await listNotifications(db, other.id)).unread).toBe(1);

		await db
			.insert(notifications)
			.values([{ userId: me.id, kind: 'review_reply', payload: { title: 'Second' } }]);
		await markNotificationsRead(db, me.id, null);
		expect((await listNotifications(db, me.id)).unread).toBe(0);
	});
});

describe('buildUserDigest', () => {
	it('composes one email from unsent rows and goes quiet once marked', async () => {
		const me = await makeUser('me@example.com');
		await db.insert(notifications).values([
			{
				userId: me.id,
				kind: 'review_activity',
				payload: { title: 'Maren commented on "Halden"', detail: 'Pacing.', href: '/x' },
				emailWanted: true
			},
			{
				userId: me.id,
				kind: 'review_activity',
				payload: { title: 'Maren suggested an edit on "Halden"' },
				emailWanted: true
			},
			// In-app only; never emailed.
			{ userId: me.id, kind: 'review_reply', payload: { title: 'Quiet' } }
		]);

		const digest = await buildUserDigest(db, me.id, 'https://codex.test');
		expect(digest).not.toBeNull();
		expect(digest!.email.to).toBe('me@example.com');
		expect(digest!.email.subject).toBe('2 updates on your Codex work');
		expect(digest!.email.text).toContain('Maren commented on "Halden"');
		expect(digest!.email.text).toContain('https://codex.test/x');
		expect(digest!.email.text).not.toContain('Quiet');

		await markEmailed(db, digest!.ids);
		expect(await buildUserDigest(db, me.id, 'https://codex.test')).toBeNull();
	});
});

describe('reviewer digests', () => {
	async function seedReview() {
		const owner = await makeUser('owner@example.com');
		const [universe] = await db
			.insert(universes)
			.values({ ownerId: owner.id, name: 'Mythos' })
			.returning();
		const [story] = await db
			.insert(stories)
			.values({ universeId: universe.id, ownerId: owner.id, title: 'Halden' })
			.returning();
		const [scene] = await db
			.insert(scenes)
			.values({ storyId: story.id, globalPosition: 1, bodyMd: 'Text.' })
			.returning();
		const [invitation] = await db
			.insert(reviewInvitations)
			.values({ storyId: story.id, createdBy: owner.id, tokenHash: 'hash' })
			.returning();
		const [guest] = await db
			.insert(reviewers)
			.values({ invitationId: invitation.id, displayName: 'Maren', email: 'maren@example.com' })
			.returning();
		const [thread] = await db
			.insert(reviewThreads)
			.values({ storyId: story.id, sceneId: scene.id })
			.returning();
		await db
			.insert(reviewComments)
			.values({ threadId: thread.id, authorReviewerId: guest.id, bodyMd: 'Pacing drags.' });
		return { owner, story, thread, guest };
	}

	it('gathers author replies since the watermark, then goes quiet', async () => {
		const { owner, thread, guest } = await seedReview();
		await db
			.insert(reviewComments)
			.values({ threadId: thread.id, authorUserId: owner.id, bodyMd: 'Will tighten.' });

		const digest = await buildReviewerDigest(db, guest.id, 'https://codex.test');
		expect(digest).not.toBeNull();
		expect(digest!.email.to).toBe('maren@example.com');
		expect(digest!.email.subject).toBe('owner replied on "Halden"');
		expect(digest!.email.text).toContain('Will tighten.');
		expect(digest!.email.text).toContain('/review-email-opt-out?token=');

		await markReviewerNotified(db, guest.id, digest!.upTo);
		expect(await buildReviewerDigest(db, guest.id, 'https://codex.test')).toBeNull();
	});

	it('stays silent for opted-out and account-linked reviewers', async () => {
		const { owner, thread, guest } = await seedReview();
		await db
			.insert(reviewComments)
			.values({ threadId: thread.id, authorUserId: owner.id, bodyMd: 'Reply.' });

		expect(await applyReviewerOptOut(db, reviewerOptOutToken(guest.id))).toBe(true);
		expect(await buildReviewerDigest(db, guest.id, 'https://codex.test')).toBeNull();
		expect(await applyReviewerOptOut(db, 'garbage.token')).toBe(false);
	});

	it('notifyThreadReviewers reaches account reviewers through the bell', async () => {
		const { thread } = await seedReview();
		const accountReviewer = await makeUser('reader@example.com');
		const [invitation] = await db.select().from(reviewInvitations);
		const [linked] = await db
			.insert(reviewers)
			.values({
				invitationId: invitation.id,
				displayName: 'Reader',
				userId: accountReviewer.id
			})
			.returning();
		await db
			.insert(reviewComments)
			.values({ threadId: thread.id, authorReviewerId: linked.id, bodyMd: 'Me too.' });

		await notifyThreadReviewers(db, thread.id, { title: 'The author replied' });
		const rows = await db
			.select()
			.from(notifications)
			.where(eq(notifications.userId, accountReviewer.id));
		expect(rows).toHaveLength(1);
		expect(rows[0].kind).toBe('review_reply');
	});
});
