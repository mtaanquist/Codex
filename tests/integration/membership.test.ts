import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	characters,
	entityMentions,
	places,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import {
	declareMembership,
	membershipStatus,
	removeMembership,
	storyEntityLists
} from '../../src/lib/server/membership';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let strangerId: string;
let universeId: string;
let storyId: string;
let memberOnlyId: string;
let mentionedOnlyId: string;
let neitherId: string;
let placeId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
	await pool.query(
		'truncate table character_story_memberships, place_story_memberships, entity_mentions, scenes, places, characters, stories, universes, users cascade'
	);

	const [owner] = await db
		.insert(users)
		.values({ email: 'mem@example.com', displayName: 'Mem', passwordHash: 'x', role: 'user' })
		.returning();
	ownerId = owner.id;
	const [stranger] = await db
		.insert(users)
		.values({ email: 'mem2@example.com', displayName: 'Mem2', passwordHash: 'x', role: 'user' })
		.returning();
	strangerId = stranger.id;
	const [universe] = await db.insert(universes).values({ ownerId, name: 'U' }).returning();
	universeId = universe.id;
	const [story] = await db.insert(stories).values({ universeId, ownerId, title: 'S' }).returning();
	storyId = story.id;

	const inserted = await db
		.insert(characters)
		.values([
			{ universeId, ownerId, name: 'Member only' },
			{ universeId, ownerId, name: 'Mentioned only' },
			{ universeId, ownerId, name: 'Neither' }
		])
		.returning();
	memberOnlyId = inserted.find((row) => row.name === 'Member only')!.id;
	mentionedOnlyId = inserted.find((row) => row.name === 'Mentioned only')!.id;
	neitherId = inserted.find((row) => row.name === 'Neither')!.id;
	const [place] = await db
		.insert(places)
		.values({ universeId, ownerId, name: 'Halden' })
		.returning();
	placeId = place.id;

	const [scene] = await db
		.insert(scenes)
		.values({ storyId, globalPosition: 1, bodyMd: 'Mentioned only walks in.' })
		.returning();
	await db.insert(entityMentions).values({
		sourceType: 'scene',
		sourceId: scene.id,
		targetType: 'character',
		targetId: mentionedOnlyId,
		position: 0,
		surroundingText: 'Mentioned only walks in.'
	});
});

afterAll(async () => {
	await pool.end();
});

describe('declareMembership and removeMembership', () => {
	it('declares idempotently and validates ownership and scope', async () => {
		expect(await declareMembership(db, ownerId, 'character', memberOnlyId, storyId)).toMatchObject({
			ok: true
		});
		expect(await declareMembership(db, ownerId, 'character', memberOnlyId, storyId)).toMatchObject({
			ok: true
		});
		expect(await declareMembership(db, ownerId, 'place', placeId, storyId)).toMatchObject({
			ok: true
		});

		expect(
			await declareMembership(db, strangerId, 'character', memberOnlyId, storyId)
		).toMatchObject({ ok: false });

		const [other] = await db.insert(universes).values({ ownerId, name: 'Other' }).returning();
		const [foreignStory] = await db
			.insert(stories)
			.values({ universeId: other.id, ownerId, title: 'F' })
			.returning();
		expect(
			await declareMembership(db, ownerId, 'character', memberOnlyId, foreignStory.id)
		).toMatchObject({ ok: false });
	});

	it('removal drops the declared signal but not the mention-derived one', async () => {
		await declareMembership(db, ownerId, 'character', mentionedOnlyId, storyId);
		expect(
			await removeMembership(db, ownerId, 'character', mentionedOnlyId, storyId)
		).toMatchObject({ ok: true });
		const status = await membershipStatus(db, 'character', mentionedOnlyId, storyId);
		expect(status).toEqual({ member: false, mentioned: true });
	});
});

describe('storyEntityLists', () => {
	it('lists members and mentioned entities, not the rest', async () => {
		const lists = await storyEntityLists(db, universeId, storyId);
		expect(lists.characters.map((row) => row.name).sort()).toEqual([
			'Member only',
			'Mentioned only'
		]);
		expect(lists.characters.map((row) => row.id)).not.toContain(neitherId);
		expect(lists.places.map((row) => row.name)).toEqual(['Halden']);
	});
});

describe('membershipStatus', () => {
	it('reports both signals independently', async () => {
		expect(await membershipStatus(db, 'character', memberOnlyId, storyId)).toEqual({
			member: true,
			mentioned: false
		});
		expect(await membershipStatus(db, 'character', neitherId, storyId)).toEqual({
			member: false,
			mentioned: false
		});
		expect(await membershipStatus(db, 'place', placeId, storyId)).toEqual({
			member: true,
			mentioned: false
		});
	});
});
