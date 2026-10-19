import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import type pg from 'pg';
import { publications, scenes, stories, universes, users } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase } from './test-db';

// The story routes import the app's db; point it at the test database.
vi.mock('$lib/server/db', async () => {
	const { default: pgModule } = await import('pg');
	const { drizzle } = await import('drizzle-orm/node-postgres');
	const schemaModule = await import('../../src/lib/server/db/schema');
	const { TEST_DATABASE_URL } = await import('./test-db');
	const testPool = new pgModule.Pool({ connectionString: TEST_DATABASE_URL });
	return { db: drizzle(testPool, { schema: schemaModule }), pool: testPool };
});

const { db, pool } = (await import('$lib/server/db')) as unknown as {
	db: Database;
	pool: pg.Pool;
};
const { destroyStory, listStoriesDueForPurge, listTrashedStories, restoreStory, trashStory } =
	await import('../../src/lib/server/story-lifecycle');
const { purgeStory } = await import('../../src/lib/server/story-delete');
const { purgeUniverse, trashUniverse } = await import('../../src/lib/server/universe-lifecycle');
const { ownedStory } = await import('../../src/lib/server/story-access');
const { ownedScene } = await import('../../src/lib/server/scene-access');
const { searchAll } = await import('../../src/lib/server/search');
const { ownedEntityBody } = await import('../../src/lib/server/revisions');
const { ownedStoryUniverse } = await import('../../src/lib/server/llm/tools/dispatch');
const { loadStoryScope, universeSkeleton } =
	await import('../../src/lib/server/llm/context/sources');
const { createReviewInvitation, ensureReviewer, invitationByToken, reviewerAccess } =
	await import('../../src/lib/server/review');
const { createChapter, createScene } = await import('../../src/lib/server/scene-lifecycle');
const { createStoryNote, getNote } = await import('../../src/lib/server/notes');
const { publicEdition, publicShelf } = await import('../../src/lib/server/publish');
const { storyProgress } = await import('../../src/lib/server/insights');
const { universeContents } = await import('../../src/lib/server/categories');
const { loadStoryLive } = await import('../../src/lib/server/story-live');
const dashboard = await import('../../src/routes/+page.server');
const settingsPage =
	await import('../../src/routes/stories/[id]/settings/[[section]]/+page.server');

let ownerId: string;
let strangerId: string;
let universeId: string;
let storyId: string;
let keptStoryId: string;
let sceneId: string;
let noteId: string;
let reviewToken: string;
let reviewerId: string;

type User = { id: string; displayName: string };
function event(user: User, options: { params?: Record<string, string>; form?: FormData } = {}) {
	const url = new URL('http://localhost/');
	return {
		params: options.params ?? {},
		url,
		request: new Request(url, { method: 'POST', body: options.form }),
		locals: { user, session: null },
		cookies: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), getAll: vi.fn(() => []) },
		getClientAddress: () => '127.0.0.1'
	};
}
function storyForm(id: string) {
	const form = new FormData();
	form.set('storyId', id);
	return form;
}
async function dashboardData(user: User) {
	return (await dashboard.load(event(user) as never)) as {
		stories: { id: string }[];
		trashedStories: { id: string; daysLeft: number }[];
	};
}

beforeAll(async () => {
	await ensureTestDatabase();
	await migrate(db, { migrationsFolder: 'drizzle' });
	await pool.query('truncate table users cascade');

	const [owner] = await db
		.insert(users)
		.values({
			email: 'trash@example.com',
			displayName: 'T',
			passwordHash: 'x',
			role: 'user',
			handle: 'trasher',
			publicArchiveEnabled: true
		})
		.returning();
	ownerId = owner.id;
	const [stranger] = await db
		.insert(users)
		.values({ email: 'trash2@example.com', displayName: 'T2', passwordHash: 'x', role: 'user' })
		.returning();
	strangerId = stranger.id;

	const [universe] = await db
		.insert(universes)
		.values({ ownerId, name: 'Harbour', slug: 'harbour' })
		.returning();
	universeId = universe.id;
	const [story] = await db
		.insert(stories)
		.values({ universeId, ownerId, title: 'Low Tide', slug: 'low-tide', visibility: 'public' })
		.returning();
	storyId = story.id;
	const [kept] = await db
		.insert(stories)
		.values({ universeId, ownerId, title: 'High Water', slug: 'high-water' })
		.returning();
	keptStoryId = kept.id;
	const [scene] = await db
		.insert(scenes)
		.values({ storyId, globalPosition: 1, title: 'Mudflats', bodyMd: 'The gulls wheeled.' })
		.returning();
	sceneId = scene.id;
	noteId = await createStoryNote(db, ownerId, universeId, storyId);
	const invitation = await createReviewInvitation(db, { storyId, createdBy: ownerId });
	reviewToken = invitation.token;
	reviewerId = (await ensureReviewer(db, invitation.id, { displayName: 'Guest' }))!.id;
	await db.insert(publications).values({
		storyId,
		ownerId,
		handle: 'trasher',
		title: 'Low Tide',
		content: { chapters: [], unfiled: [{ title: 'Mudflats', bodyMd: 'The gulls wheeled.' }] },
		isCurrent: true
	});
});

afterAll(async () => {
	await pool.end();
});

describe('story trash', () => {
	it('the settings delete action moves the story to the trash, not out of the database', async () => {
		const owner = { id: ownerId, displayName: 'T' };
		await expect(
			settingsPage.actions.delete(event(owner, { params: { id: storyId } }) as never)
		).rejects.toMatchObject({ status: 303, location: '/universes/harbour' });

		const [row] = await db.select().from(stories).where(eq(stories.id, storyId));
		expect(row.deletedAt).not.toBeNull();
		expect(await db.select().from(scenes).where(eq(scenes.id, sceneId))).toHaveLength(1);
	});

	it('only the owner can trash a story', async () => {
		expect(await trashStory(db, strangerId, keptStoryId)).toBe(false);
		// Already in the trash.
		expect(await trashStory(db, ownerId, storyId)).toBe(false);
	});

	it('hides the trashed story from the dashboard and lists it in the trash', async () => {
		const data = await dashboardData({ id: ownerId, displayName: 'T' });
		expect(data.stories.map((s) => s.id)).toEqual([keptStoryId]);
		expect(data.trashedStories.map((s) => s.id)).toEqual([storyId]);
		expect(data.trashedStories[0].daysLeft).toBe(30);
		expect(await listTrashedStories(db, strangerId)).toEqual([]);
	});

	it('hides it from the universe listings, search, and the public shelf', async () => {
		expect((await storyProgress(db, universeId)).map((s) => s.id)).toEqual([keptStoryId]);
		expect((await universeContents(db, universeId)).stories).toBe(1);
		expect((await universeSkeleton(db, universeId)).map((s) => s.storyId)).toEqual([keptStoryId]);
		const live = await loadStoryLive(db, { storyId: keptStoryId, universeId, sceneId: null });
		expect(JSON.stringify(live)).not.toContain(storyId);
		expect(await searchAll(db, ownerId, 'Low Tide')).toEqual([]);
		expect(await searchAll(db, ownerId, 'Mudflats')).toEqual([]);
		expect(await searchAll(db, ownerId, 'gulls')).toEqual([]);
		expect(await publicShelf(db, 'trasher')).toEqual([]);
		expect(await publicEdition(db, 'trasher', storyId)).toBeNull();
	});

	it('refuses by-id lookups, the Assistant, and the review link', async () => {
		await expect(ownedStory('low-tide', ownerId, db)).rejects.toMatchObject({ status: 404 });
		await expect(ownedStory(storyId, ownerId, db)).rejects.toMatchObject({ status: 404 });
		expect(await ownedScene(db, ownerId, sceneId)).toBeNull();
		expect(await ownedEntityBody(db, ownerId, 'scene', sceneId)).toBeNull();
		expect(await ownedEntityBody(db, ownerId, 'note', noteId)).toBeNull();
		expect(await getNote(db, noteId, ownerId)).toBeNull();
		expect(await ownedStoryUniverse(db, ownerId, storyId)).toBeNull();
		expect(await loadStoryScope(db, ownerId, storyId)).toBeNull();
		expect((await invitationByToken(db, reviewToken)).status).toBe('unknown');
		expect(await reviewerAccess(db, reviewerId, storyId)).toBeNull();
		expect(await createScene(db, ownerId, storyId)).toBeNull();
		expect(await createChapter(db, ownerId, storyId)).toBeNull();
	});

	it('restore brings the story back whole under the same slug', async () => {
		expect(await restoreStory(db, strangerId, storyId)).toBe(false);
		const owner = { id: ownerId, displayName: 'T' };
		expect(
			await dashboard.actions.restoreStory(event(owner, { form: storyForm(storyId) }) as never)
		).toEqual({ scope: 'story-trash', restored: true });

		expect((await ownedStory('low-tide', ownerId, db)).story.id).toBe(storyId);
		expect((await ownedScene(db, ownerId, sceneId))?.id).toBe(sceneId);
		expect((await getNote(db, noteId, ownerId))?.id).toBe(noteId);
		expect((await invitationByToken(db, reviewToken)).status).toBe('ok');
		expect((await publicShelf(db, 'trasher')).map((row) => row.storyId)).toEqual([storyId]);
		expect((await dashboardData(owner)).trashedStories).toEqual([]);
		// Not in the trash any more.
		expect(await restoreStory(db, ownerId, storyId)).toBe(false);
	});

	it('is due for the purge only once the window elapses, and the purge removes it', async () => {
		expect(await trashStory(db, ownerId, storyId)).toBe(true);
		expect(await listStoriesDueForPurge(db)).toEqual([]);
		await db
			.update(stories)
			.set({ deletedAt: sql`now() - interval '31 days'` })
			.where(eq(stories.id, storyId));
		expect(await listStoriesDueForPurge(db)).toEqual([storyId]);

		await purgeStory(db, storyId);
		expect(await db.select().from(stories).where(eq(stories.id, storyId))).toHaveLength(0);
		expect(await db.select().from(scenes).where(eq(scenes.id, sceneId))).toHaveLength(0);
		expect(await listStoriesDueForPurge(db)).toEqual([]);
		expect(await db.select().from(stories).where(eq(stories.id, keptStoryId))).toHaveLength(1);
	});

	it('delete forever refuses a live story and removes a trashed one', async () => {
		const owner = { id: ownerId, displayName: 'T' };
		const refused = await dashboard.actions.destroyStory(
			event(owner, { form: storyForm(keptStoryId) }) as never
		);
		expect(refused).toMatchObject({ status: 404 });
		expect(await trashStory(db, ownerId, keptStoryId)).toBe(true);
		expect(await destroyStory(db, strangerId, keptStoryId)).toBe(false);
		expect(
			await dashboard.actions.destroyStory(event(owner, { form: storyForm(keptStoryId) }) as never)
		).toEqual({ scope: 'story-trash', destroyed: true });
		expect(await db.select().from(stories).where(eq(stories.id, keptStoryId))).toHaveLength(0);
	});

	it('a universe purge still removes its stories, trashed or not', async () => {
		const [trashed] = await db
			.insert(stories)
			.values({ universeId, ownerId, title: 'Ebb', slug: 'ebb' })
			.returning();
		expect(await trashStory(db, ownerId, trashed.id)).toBe(true);
		// A story inside a trashed universe is listed with the universe, not on
		// its own.
		expect(await trashUniverse(db, ownerId, universeId)).toBe(true);
		expect(await listTrashedStories(db, ownerId)).toEqual([]);
		await purgeUniverse(db, universeId);
		expect(await db.select().from(stories).where(eq(stories.universeId, universeId))).toEqual([]);
	});
});
