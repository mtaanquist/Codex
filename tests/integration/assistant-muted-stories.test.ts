import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

// A story muted for the Assistant stays out of universe-wide Assistant work:
// its scenes are not listed, read, searched, or quoted to the model from any
// other surface. The Plan page's own lists still show it.

process.env.APP_SECRET = process.env.APP_SECRET || 'muted-stories-test-secret';

const { saveStoryLlmOverride } = await import('../../src/lib/server/llm/config');
const { universeSkeleton } = await import('../../src/lib/server/llm/context/sources');
const { dispatchToolCall } = await import('../../src/lib/server/llm/tools/dispatch');
const { entityAppearances } = await import('../../src/lib/server/plan-data');

let pool: pg.Pool;
let db: Database;
let userId: string;
let universeId: string;
let openStoryId: string;
let mutedStoryId: string;
let mutedSceneId: string;
let characterId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

afterAll(async () => {
	await pool.end();
});

beforeEach(async () => {
	await pool.query(
		'truncate table entity_mentions, scenes, characters, stories, universes, users cascade'
	);
	const [user] = await db
		.insert(users)
		.values({ email: 'm@example.com', displayName: 'Mira', passwordHash: 'x', role: 'user' })
		.returning({ id: users.id });
	userId = user.id;
	const [universe] = await db
		.insert(universes)
		.values({ ownerId: userId, name: 'Aldermoor' })
		.returning({ id: universes.id });
	universeId = universe.id;
	const [open] = await db
		.insert(stories)
		.values({ universeId, ownerId: userId, title: 'Open Book' })
		.returning({ id: stories.id });
	openStoryId = open.id;
	const [muted] = await db
		.insert(stories)
		.values({ universeId, ownerId: userId, title: 'Private Book' })
		.returning({ id: stories.id });
	mutedStoryId = muted.id;
	await saveStoryLlmOverride(db, mutedStoryId, { enabled: false });

	const [character] = await db
		.insert(characters)
		.values({ universeId, ownerId: userId, name: 'Bram' })
		.returning({ id: characters.id });
	characterId = character.id;
	const [openScene] = await db
		.insert(scenes)
		.values({ storyId: openStoryId, globalPosition: 1, title: 'Quay', bodyMd: 'Bram waves.' })
		.returning({ id: scenes.id });
	const [mutedScene] = await db
		.insert(scenes)
		.values({
			storyId: mutedStoryId,
			globalPosition: 1,
			title: 'Secret',
			bodyMd: 'Bram whispers the secret.'
		})
		.returning({ id: scenes.id });
	mutedSceneId = mutedScene.id;
	for (const [sceneId, text] of [
		[openScene.id, 'Bram waves.'],
		[mutedScene.id, 'Bram whispers the secret.']
	]) {
		await db.insert(entityMentions).values({
			sourceType: 'scene',
			sourceId: sceneId,
			targetType: 'character',
			targetId: characterId,
			position: 0,
			surroundingText: text
		});
	}
});

function tool(name: string, args: Record<string, unknown>) {
	return dispatchToolCall(
		{ db, userId, universeId, storyId: openStoryId },
		{ id: 'call', name, arguments: JSON.stringify(args) }
	);
}

describe('muted stories and universe-wide Assistant work', () => {
	it('leaves a muted story out of the universe outline', async () => {
		const skeleton = await universeSkeleton(db, universeId);
		expect(skeleton.map((s) => s.storyTitle)).toEqual(['Open Book']);
	});

	it('does not list, read, search, or quote a muted story through the tools', async () => {
		expect((await tool('list_scenes', {})).result).not.toContain('Private Book');
		expect((await tool('get_scene', { sceneId: mutedSceneId })).result).toContain(
			'No scene with that id'
		);
		const search = (await tool('search_text', { query: 'Bram' })).result;
		expect(search).not.toContain('secret');
		expect(search).not.toContain('Private Book');
		const found = (await tool('find_appearances', { entityId: characterId })).result;
		expect(found).toContain('Bram waves.');
		expect(found).not.toContain('secret');
	});

	it("keeps the muted story in the Plan page's own appearances", async () => {
		const all = await entityAppearances(db, { kind: 'character', id: characterId }, { universeId });
		expect(all.map((a) => a.storyTitle).sort()).toEqual(['Open Book', 'Private Book']);
	});

	it('brings the story back once the mute is cleared', async () => {
		await saveStoryLlmOverride(db, mutedStoryId, { enabled: null });
		const skeleton = await universeSkeleton(db, universeId);
		expect(skeleton.map((s) => s.storyTitle).sort()).toEqual(['Open Book', 'Private Book']);
	});
});
