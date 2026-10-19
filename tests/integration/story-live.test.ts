import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	characters,
	entityMentions,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import { loadSceneMeta, loadStoryLive } from '../../src/lib/server/story-live';
import { recordRevision } from '../../src/lib/server/revisions';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let universeId: string;
let storyId: string;
let otherStoryId: string;
let sceneId: string;
let otherSceneId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
	await pool.query(
		'truncate table entity_mentions, revisions, scene_markers, scenes, chapters, characters, stories, universes, users cascade'
	);
	const [owner] = await db
		.insert(users)
		.values({ email: 'live@example.com', displayName: 'Live', passwordHash: 'x', role: 'user' })
		.returning();
	const [universe] = await db
		.insert(universes)
		.values({ ownerId: owner.id, name: 'U' })
		.returning();
	universeId = universe.id;
	const [story] = await db
		.insert(stories)
		.values({ universeId, ownerId: owner.id, title: 'Live' })
		.returning();
	storyId = story.id;
	const [other] = await db
		.insert(stories)
		.values({ universeId, ownerId: owner.id, title: 'Other' })
		.returning();
	otherStoryId = other.id;
	const [scene] = await db
		.insert(scenes)
		.values({
			storyId,
			globalPosition: 1,
			title: 'Gate',
			bodyMd: 'Alice waits. TODO: name the gate.',
			wordCount: 6
		})
		.returning();
	sceneId = scene.id;
	const [otherScene] = await db
		.insert(scenes)
		.values({ storyId: otherStoryId, globalPosition: 1, bodyMd: 'Elsewhere.', wordCount: 1 })
		.returning();
	otherSceneId = otherScene.id;
	await recordRevision(db, 'scene', sceneId, scene.bodyMd);
	const [alice] = await db
		.insert(characters)
		.values({ universeId, ownerId: owner.id, name: 'Alice' })
		.returning();
	await db.insert(entityMentions).values({
		sourceType: 'scene',
		sourceId: sceneId,
		targetType: 'character',
		targetId: alice.id,
		position: 0,
		surroundingText: 'Alice waits.'
	});
});

afterAll(async () => {
	await pool.end();
});

describe('loadStoryLive', () => {
	it('reads the counts, history and mentions a save changes', async () => {
		const live = await loadStoryLive(db, { storyId, universeId, sceneId });
		expect(live.scenes).toEqual([expect.objectContaining({ id: sceneId, wordCount: 6 })]);
		expect(live.storySiblings.find((s) => s.id === storyId)?.words).toBe(6);
		expect(live.sceneRevisions).toHaveLength(1);
		expect(live.inScene).toEqual([
			expect.objectContaining({ name: 'Alice', kind: 'character', count: 1 })
		]);
	});

	it('leaves the scene parts empty without an open scene', async () => {
		const live = await loadStoryLive(db, { storyId, universeId, sceneId: null });
		expect(live.sceneRevisions).toEqual([]);
		expect(live.inScene).toEqual([]);
	});
});

describe('loadSceneMeta', () => {
	it('reads the open scene, and nothing for a scene of another story', async () => {
		expect(await loadSceneMeta(db, storyId, sceneId)).toMatchObject({
			title: 'Gate',
			wordCount: 6
		});
		expect(await loadSceneMeta(db, storyId, otherSceneId)).toBeNull();
	});
});
