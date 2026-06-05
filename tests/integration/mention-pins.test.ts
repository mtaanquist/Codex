import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	characters,
	entityMentions,
	places,
	placeStoryMemberships,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import { clearMentionPin, listMentionPins, setMentionPin } from '../../src/lib/server/mention-pins';
import { rebuildSceneMentions } from '../../src/lib/server/mentions';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

// Shared names: "Will" is both a character and a place. Attribution is
// deterministic, story members outrank, and a pin overrides.

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let strangerId: string;
let storyId: string;
let sceneId: string;
let willCharacterId: string;
let willPlaceId: string;

async function attributedTo() {
	const rows = await db
		.select({ targetType: entityMentions.targetType, targetId: entityMentions.targetId })
		.from(entityMentions)
		.where(eq(entityMentions.sourceId, sceneId));
	expect(rows).toHaveLength(1);
	return rows[0];
}

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
	await pool.query(
		'truncate table mention_pins, entity_mentions, character_story_memberships, place_story_memberships, scenes, chapters, places, characters, stories, universes, users cascade'
	);

	const [owner] = await db
		.insert(users)
		.values({ email: 'pin@example.com', displayName: 'P', passwordHash: 'x', role: 'user' })
		.returning();
	ownerId = owner.id;
	const [stranger] = await db
		.insert(users)
		.values({ email: 'pin2@example.com', displayName: 'P2', passwordHash: 'x', role: 'user' })
		.returning();
	strangerId = stranger.id;
	const [universe] = await db.insert(universes).values({ ownerId, name: 'U' }).returning();
	const [story] = await db
		.insert(stories)
		.values({ universeId: universe.id, ownerId, title: 'S' })
		.returning();
	storyId = story.id;
	const [scene] = await db
		.insert(scenes)
		.values({ storyId, globalPosition: 1, bodyMd: 'Will stood at the gate.' })
		.returning();
	sceneId = scene.id;

	const [willCharacter] = await db
		.insert(characters)
		.values({ universeId: universe.id, ownerId, name: 'Will' })
		.returning();
	willCharacterId = willCharacter.id;
	const [willPlace] = await db
		.insert(places)
		.values({ universeId: universe.id, ownerId, name: 'Will' })
		.returning();
	willPlaceId = willPlace.id;
});

afterAll(async () => {
	await pool.end();
});

describe('shared-name attribution in the index', () => {
	it('the deterministic default prefers the character', async () => {
		await rebuildSceneMentions(db, sceneId);
		expect(await attributedTo()).toEqual({ targetType: 'character', targetId: willCharacterId });
	});

	it('a story member outranks the default', async () => {
		await db.insert(placeStoryMemberships).values({ placeId: willPlaceId, storyId });
		await rebuildSceneMentions(db, sceneId);
		expect(await attributedTo()).toEqual({ targetType: 'place', targetId: willPlaceId });
	});

	it('a pin overrides the member rule', async () => {
		const result = await setMentionPin(db, ownerId, storyId, 'Will', 'character', willCharacterId);
		expect(result).toMatchObject({ ok: true });
		await rebuildSceneMentions(db, sceneId);
		expect(await attributedTo()).toEqual({ targetType: 'character', targetId: willCharacterId });
	});

	it('clearing the pin falls back to the member rule', async () => {
		expect(await clearMentionPin(db, ownerId, storyId, 'Will')).toBe(true);
		expect(await listMentionPins(db, storyId)).toEqual(new Map());
		await rebuildSceneMentions(db, sceneId);
		expect(await attributedTo()).toEqual({ targetType: 'place', targetId: willPlaceId });
	});

	it('only the owner can pin, and the target must share the universe', async () => {
		expect(await setMentionPin(db, strangerId, storyId, 'Will', 'place', willPlaceId)).toEqual({
			ok: false,
			reason: 'story not found'
		});
		expect(
			await setMentionPin(db, ownerId, storyId, 'Will', 'character', willPlaceId)
		).toMatchObject({ ok: false });
	});
});
