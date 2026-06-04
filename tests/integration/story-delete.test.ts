import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, eq } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	characters,
	characterStoryMemberships,
	characterStoryNotes,
	chapters,
	entityCategories,
	entityMentions,
	entityRelationships,
	loreEntries,
	outlineNodes,
	placeStoryMemberships,
	places,
	publicationAssets,
	publications,
	relationTypes,
	revisions,
	sceneMarkers,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import { deleteStory } from '../../src/lib/server/story-delete';
import type { Database } from '../../src/lib/server/auth';
import { ensureBuiltInRelationTypes, ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let universeId: string;
let storyId: string;
let otherStoryId: string;
let characterId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
	await pool.query(
		'truncate table publication_assets, publications, scene_markers, revisions, entity_mentions, entity_relationships, outline_nodes, character_story_memberships, place_story_memberships, character_story_notes, place_story_notes, lore_story_notes, scenes, chapters, characters, places, lore_entries, entity_categories, stories, universes, users cascade'
	);
	await ensureBuiltInRelationTypes(pool);

	const [owner] = await db
		.insert(users)
		.values({ email: 'del@example.com', displayName: 'Del', passwordHash: 'x', role: 'user' })
		.returning();
	ownerId = owner.id;
	const [universe] = await db.insert(universes).values({ ownerId, name: 'U' }).returning();
	universeId = universe.id;
	const [story] = await db
		.insert(stories)
		.values({ universeId, ownerId, title: 'Doomed', visibility: 'public', isAdult: false })
		.returning();
	storyId = story.id;
	const [other] = await db
		.insert(stories)
		.values({ universeId, ownerId, title: 'Survivor' })
		.returning();
	otherStoryId = other.id;

	// Universe-scoped entities that must survive the story delete.
	const [category] = await db
		.insert(entityCategories)
		.values({ universeId, ownerId, name: 'Lore', sortOrder: 0 })
		.returning();
	const [alice] = await db
		.insert(characters)
		.values({ universeId, ownerId, name: 'Alice' })
		.returning();
	characterId = alice.id;
	const [place] = await db
		.insert(places)
		.values({ universeId, ownerId, name: 'Halden' })
		.returning();
	await db
		.insert(loreEntries)
		.values({ universeId, ownerId, categoryId: category.id, title: 'Toll-pass' });

	// One of every story-scoped row.
	const [chapter] = await db
		.insert(chapters)
		.values({ storyId, title: 'Ch1', position: 1 })
		.returning();
	const [scene] = await db
		.insert(scenes)
		.values({ storyId, chapterId: chapter.id, globalPosition: 1, title: 'S1', bodyMd: 'Alice.' })
		.returning();
	await db
		.insert(sceneMarkers)
		.values({ sceneId: scene.id, ownerId, anchorStart: 0, anchorEnd: 5 });
	await db.insert(revisions).values({ entityType: 'scene', entityId: scene.id, bodyMd: 'Alice.' });
	await db.insert(entityMentions).values({
		sourceType: 'scene',
		sourceId: scene.id,
		targetType: 'character',
		targetId: alice.id,
		position: 0,
		surroundingText: 'Alice.'
	});
	const [node] = await db
		.insert(outlineNodes)
		.values({ storyId, position: 1, title: 'Act 1' })
		.returning();
	await db.insert(outlineNodes).values({ storyId, parentId: node.id, position: 1, title: 'Beat' });
	await db.insert(characterStoryNotes).values({ characterId: alice.id, storyId, notesMd: 'note' });
	await db.insert(characterStoryMemberships).values({ characterId: alice.id, storyId });
	await db.insert(placeStoryMemberships).values({ placeId: place.id, storyId });
	// A story-scoped relationship and a universe-wide one.
	const [livesIn] = await db.select().from(relationTypes).where(eq(relationTypes.key, 'lives_in'));
	await db.insert(entityRelationships).values({
		universeId,
		ownerId,
		fromType: 'character',
		fromId: alice.id,
		toType: 'place',
		toId: place.id,
		relationTypeId: livesIn.id,
		storyId
	});
	await db.insert(entityRelationships).values({
		universeId,
		ownerId,
		fromType: 'character',
		fromId: alice.id,
		toType: 'place',
		toId: place.id,
		relationTypeId: livesIn.id,
		storyId: null
	});
	// A published edition with an asset reference.
	const [pub] = await db
		.insert(publications)
		.values({ storyId, ownerId, handle: 'del', title: 'Doomed', content: {}, isCurrent: true })
		.returning();
	const [asset] = await db
		.insert(schema.assets)
		.values({
			ownerId,
			universeId,
			kind: 'inline',
			filename: 'x.png',
			contentType: 'image/png',
			byteSize: 1,
			storageKey: 'k'
		})
		.returning();
	await db.insert(publicationAssets).values({ publicationId: pub.id, assetId: asset.id });
});

afterAll(async () => {
	await pool.end();
});

describe('deleteStory', () => {
	it('refuses a story the user does not own', async () => {
		const [stranger] = await db
			.insert(users)
			.values({ email: 's@example.com', displayName: 'S', passwordHash: 'x', role: 'user' })
			.returning();
		expect(await deleteStory(db, storyId, stranger.id)).toBe(false);
		const [stillThere] = await db.select().from(stories).where(eq(stories.id, storyId));
		expect(stillThere).toBeDefined();
	});

	it('clears every story-scoped row and leaves the universe intact', async () => {
		expect(await deleteStory(db, storyId, ownerId)).toBe(true);

		// The story and all its scoped rows are gone.
		expect(await db.select().from(stories).where(eq(stories.id, storyId))).toHaveLength(0);
		expect(await db.select().from(chapters).where(eq(chapters.storyId, storyId))).toHaveLength(0);
		expect(await db.select().from(scenes).where(eq(scenes.storyId, storyId))).toHaveLength(0);
		expect(
			await db.select().from(outlineNodes).where(eq(outlineNodes.storyId, storyId))
		).toHaveLength(0);
		expect(
			await db.select().from(publications).where(eq(publications.storyId, storyId))
		).toHaveLength(0);
		expect(
			await db
				.select()
				.from(characterStoryMemberships)
				.where(eq(characterStoryMemberships.storyId, storyId))
		).toHaveLength(0);
		expect(
			await db.select().from(entityRelationships).where(eq(entityRelationships.storyId, storyId))
		).toHaveLength(0);

		// Universe-scoped entities survive.
		const [alice] = await db.select().from(characters).where(eq(characters.id, characterId));
		expect(alice).toBeDefined();
		expect(
			await db.select().from(characters).where(eq(characters.universeId, universeId))
		).toHaveLength(1);
		// The other story and the universe-wide relationship survive.
		expect(await db.select().from(stories).where(eq(stories.id, otherStoryId))).toHaveLength(1);
		const universeWide = await db
			.select()
			.from(entityRelationships)
			.where(and(eq(entityRelationships.universeId, universeId)));
		expect(universeWide).toHaveLength(1);
	});
});
