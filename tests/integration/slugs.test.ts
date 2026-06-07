import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { entityCategories, stories, universes, users } from '../../src/lib/server/db/schema';
import { uniqueSlug } from '../../src/lib/server/slugs';
import { createStoryInUniverse, standaloneUniverse } from '../../src/lib/server/story-create';
import { ownedStory } from '../../src/lib/server/story-access';
import { ownedUniverse } from '../../src/lib/server/universe-access';
import { isValidSlug } from '../../src/lib/slug';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let otherId: string;
let universeId: string;
let storyId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
	await pool.query('truncate table stories, universes, users cascade');

	const [owner] = await db
		.insert(users)
		.values({ email: 'slug@example.com', displayName: 'S', passwordHash: 'x', role: 'user' })
		.returning();
	ownerId = owner.id;
	const [other] = await db
		.insert(users)
		.values({ email: 'slug2@example.com', displayName: 'S2', passwordHash: 'x', role: 'user' })
		.returning();
	otherId = other.id;
	const [universe] = await db
		.insert(universes)
		.values({ ownerId, name: 'Ardenfall', slug: 'ardenfall' })
		.returning();
	universeId = universe.id;
	const [story] = await db
		.insert(stories)
		.values({ universeId, ownerId, title: 'The Toll', slug: 'the-toll' })
		.returning();
	storyId = story.id;
});

afterAll(async () => {
	await pool.end();
});

describe('uniqueSlug', () => {
	it('uses the plain slug when free', async () => {
		expect(await uniqueSlug(db, 'universes', ownerId, 'Eressëa', 'universe')).toBe('eressea');
	});

	it('suffixes within the owner, counting past gaps', async () => {
		expect(await uniqueSlug(db, 'universes', ownerId, 'Ardenfall', 'universe')).toBe('ardenfall-2');
		await db.insert(universes).values({ ownerId, name: 'Ardenfall', slug: 'ardenfall-2' });
		expect(await uniqueSlug(db, 'universes', ownerId, 'Ardenfall', 'universe')).toBe('ardenfall-3');
	});

	it('another owner gets the plain slug', async () => {
		expect(await uniqueSlug(db, 'universes', otherId, 'Ardenfall', 'universe')).toBe('ardenfall');
	});

	it('falls back when the name slugs to nothing', async () => {
		expect(await uniqueSlug(db, 'stories', ownerId, '***', 'story')).toBe('story');
	});

	it('suffixes a uuid-shaped base so the slug stays routable', async () => {
		const slug = await uniqueSlug(
			db,
			'stories',
			ownerId,
			'8f3a1c2e 1234 4abc 9def 001122334455',
			'story'
		);
		expect(slug).toBe('8f3a1c2e-1234-4abc-9def-001122334455-2');
		expect(isValidSlug(slug)).toBe(true);
	});
});

// The resolvers behind every /universes/[id] and /stories/[id] route: slugs
// and ids both resolve, and ownership scopes the lookup.
describe('ownedUniverse / ownedStory', () => {
	it('resolves by slug and by id', async () => {
		expect((await ownedUniverse('ardenfall', ownerId, db)).id).toBe(universeId);
		expect((await ownedUniverse(universeId, ownerId, db)).slug).toBe('ardenfall');
		expect((await ownedStory('the-toll', ownerId, db)).story.id).toBe(storyId);
		const byId = await ownedStory(storyId, ownerId, db);
		expect(byId.story.slug).toBe('the-toll');
		expect(byId.universe.id).toBe(universeId);
	});

	it("404s on another user's ref and on unknown refs", async () => {
		await expect(ownedUniverse('ardenfall', otherId, db)).rejects.toMatchObject({ status: 404 });
		await expect(ownedUniverse(universeId, otherId, db)).rejects.toMatchObject({ status: 404 });
		await expect(ownedStory('no-such-story', ownerId, db)).rejects.toMatchObject({ status: 404 });
		await expect(
			ownedStory('00000000-0000-4000-8000-000000000000', ownerId, db)
		).rejects.toMatchObject({ status: 404 });
	});
});

describe('createStoryInUniverse', () => {
	it('creates a story with a readable slug, suffixing on a repeat title', async () => {
		const first = await createStoryInUniverse(db, ownerId, universeId, 'Night Watch');
		expect(first.slug).toBe('night-watch');
		expect(first.universeId).toBe(universeId);
		const second = await createStoryInUniverse(db, ownerId, universeId, 'Night Watch');
		expect(second.slug).toBe('night-watch-2');
	});
});

describe('standaloneUniverse', () => {
	it('creates the home for one-off stories once, then reuses it', async () => {
		const first = await standaloneUniverse(db, ownerId);
		expect(first.name).toBe('Standalone stories');
		expect(first.standalone).toBe(true);
		// Lore needs a category, so the starter pair comes along.
		const categories = await db
			.select()
			.from(entityCategories)
			.where(eq(entityCategories.universeId, first.id));
		expect(categories.map((c) => c.name).sort()).toEqual(['Faction', 'Lore']);

		const again = await standaloneUniverse(db, ownerId);
		expect(again.id).toBe(first.id);

		// Another owner gets their own.
		const theirs = await standaloneUniverse(db, otherId);
		expect(theirs.id).not.toBe(first.id);

		// And a story files into it like any universe.
		const story = await createStoryInUniverse(db, ownerId, first.id, 'A One-Off');
		expect(story.universeId).toBe(first.id);
	});
});
