import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	chapters,
	characters,
	characterStoryMemberships,
	characterStoryNotes,
	entityCategories,
	loreEntries,
	notes,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

const { assembleContext, assembleRecapContext } =
	await import('../../src/lib/server/llm/context/assemble');

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let strangerId: string;
let universeId: string;
let storyId: string;
let scene1Id: string;
let scene2Id: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query(
		'truncate table notes, lore_story_notes, lore_entries, character_story_notes, character_story_memberships, characters, entity_categories, scenes, chapters, stories, universes, users cascade'
	);
	const [owner] = await db
		.insert(users)
		.values({ email: 'o@example.com', displayName: 'Olwen', passwordHash: 'x', role: 'user' })
		.returning({ id: users.id });
	ownerId = owner.id;
	const [stranger] = await db
		.insert(users)
		.values({ email: 's@example.com', displayName: 'Sam', passwordHash: 'x', role: 'user' })
		.returning({ id: users.id });
	strangerId = stranger.id;

	const [universe] = await db
		.insert(universes)
		.values({ ownerId, name: 'Aldermoor', descriptionMd: 'A drowned kingdom of canals.' })
		.returning({ id: universes.id });
	universeId = universe.id;
	const [category] = await db
		.insert(entityCategories)
		.values({ universeId, ownerId, name: 'Lore', color: '#888', sortOrder: 0 })
		.returning({ id: entityCategories.id });
	const categoryId = category.id;

	const [story] = await db
		.insert(stories)
		.values({
			universeId,
			ownerId,
			title: 'The Tide Below',
			brief: 'A diver hunts a sunken bell.',
			descriptionMd: 'Long synopsis of the descent.',
			styleNotes: 'Nautical gothic, slow and ornate.'
		})
		.returning({ id: stories.id });
	storyId = story.id;
	const [chapter] = await db
		.insert(chapters)
		.values({ storyId, position: 1, title: 'Descent', summaryMd: 'They go under.' })
		.returning({ id: chapters.id });

	const [scene1] = await db
		.insert(scenes)
		.values({
			storyId,
			chapterId: chapter.id,
			globalPosition: 1,
			title: 'The Gate',
			bodyMd: 'Alice met Bram by the Aether gate at dawn.',
			summaryMd: 'Alice and Bram meet.',
			status: 'draft'
		})
		.returning({ id: scenes.id });
	scene1Id = scene1.id;
	const [scene2] = await db
		.insert(scenes)
		.values({
			storyId,
			chapterId: chapter.id,
			globalPosition: 2,
			title: 'The Quiet Road',
			bodyMd: '',
			summaryMd: 'A calm walk south.',
			status: 'outline'
		})
		.returning({ id: scenes.id });
	scene2Id = scene2.id;

	const [alice] = await db
		.insert(characters)
		.values({
			universeId,
			ownerId,
			name: 'Alice',
			summaryMd: 'A brave knight.',
			aliases: ['Al'],
			details: [{ label: 'Eyes', value: 'green' }]
		})
		.returning({ id: characters.id });
	await db.insert(characterStoryMemberships).values({ characterId: alice.id, storyId });
	await db
		.insert(characterStoryNotes)
		.values({ characterId: alice.id, storyId, notesMd: 'Wounded in the first chapter.' });

	await db.insert(loreEntries).values([
		{
			universeId,
			ownerId,
			categoryId,
			title: 'The Aether',
			summaryMd: 'The magic field over the sea.',
			bodyMd: 'Aether pools in the deep places.',
			keywords: ['Aether'],
			activationMode: 'keyword'
		},
		{
			universeId,
			ownerId,
			categoryId,
			title: 'Creation Myth',
			summaryMd: 'How the kingdom drowned.',
			bodyMd: 'In the beginning the tide rose.',
			activationMode: 'always'
		},
		{
			universeId,
			ownerId,
			categoryId,
			title: 'The Forbidden Name',
			summaryMd: 'A secret never auto-injected.',
			bodyMd: 'Hidden lore about the Aether.',
			keywords: ['Aether'],
			activationMode: 'manual'
		}
	]);

	await db.insert(notes).values([
		{
			ownerId,
			universeId,
			storyId,
			title: 'Plot',
			bodyMd: 'The bell tolls a betrayal.',
			pinned: true
		},
		{ ownerId, universeId, storyId: null, title: 'World rule', bodyMd: 'Iron does not rust here.' }
	]);
});

afterAll(async () => {
	await pool.end();
});

describe('assembleContext', () => {
	it('returns null for a story the user does not own', async () => {
		expect(await assembleContext(db, { userId: strangerId, storyId })).toBeNull();
	});

	it('frames the story and world', async () => {
		const context = await assembleContext(db, { userId: ownerId, storyId, sceneId: scene1Id });
		expect(context).not.toBeNull();
		expect(context!.text).toContain('The Tide Below');
		expect(context!.text).toContain('Aldermoor');
		expect(context!.text).toContain('A drowned kingdom of canals.');
		expect(context!.text).toContain('Nautical gothic, slow and ornate.');
	});

	it('includes the current scene body and a member entity with its details and story note', async () => {
		const context = await assembleContext(db, { userId: ownerId, storyId, sceneId: scene1Id });
		expect(context!.text).toContain('Alice met Bram by the Aether gate at dawn.');
		expect(context!.text).toContain('Alice');
		expect(context!.text).toContain('A brave knight.');
		expect(context!.text).toContain('green'); // a quick detail
		expect(context!.text).toContain('Al'); // an alias
		expect(context!.text).toContain('Wounded in the first chapter.'); // the per-story note
		expect(context!.sources.entities.map((e) => e.name)).toContain('Alice');
	});

	it('activates always-on lore and keyword lore matched by the scene, but never manual lore', async () => {
		const context = await assembleContext(db, { userId: ownerId, storyId, sceneId: scene1Id });
		expect(context!.text).toContain('Creation Myth'); // always
		expect(context!.text).toContain('The Aether'); // keyword 'Aether' is in the scene
		expect(context!.text).not.toContain('The Forbidden Name'); // manual, never auto-injected
		const loreTitles = context!.sources.lore.map((l) => l.title);
		expect(loreTitles).toContain('The Aether');
		expect(loreTitles).not.toContain('The Forbidden Name');
	});

	it('does not activate keyword lore when the keyword is absent from scope', async () => {
		// scene2 has no body and no Aether in its neighbourhood summaries.
		const context = await assembleContext(db, { userId: ownerId, storyId, sceneId: scene2Id });
		expect(context!.text).toContain('Creation Myth'); // always still in
		expect(context!.text).not.toContain('The Aether');
	});

	it('includes story and universe notes', async () => {
		const context = await assembleContext(db, { userId: ownerId, storyId, sceneId: scene1Id });
		expect(context!.text).toContain('The bell tolls a betrayal.');
		expect(context!.text).toContain('Iron does not rust here.');
	});

	it('renders scene ids in the outline and nearby-scene lines', async () => {
		const context = await assembleContext(db, { userId: ownerId, storyId, sceneId: scene1Id });
		// The outline line for the non-focus scene carries its id, so a
		// tool-capable turn can read it in full with get_scene.
		expect(context!.text).toContain(`(scene id: ${scene2Id}): A calm walk south.`);
		expect(context!.text).toContain(`(scene id: ${scene1Id}): Alice and Bram meet.`);
		// The nearby-scenes line under the current scene carries the id too.
		expect(context!.text).toContain(`- After "The Quiet Road" (scene id: ${scene2Id})`);
	});

	it('keeps only the frame under a tiny budget, dropping the rest', async () => {
		const context = await assembleContext(db, {
			userId: ownerId,
			storyId,
			sceneId: scene1Id,
			budgetTokens: 1
		});
		expect(context!.includedTiers).toEqual(['frame']);
		expect(context!.droppedTiers.length).toBeGreaterThan(0);
		expect(context!.text).not.toContain('Alice met Bram');
	});
});

describe('assembleRecapContext', () => {
	it('returns null for a story the user does not own', async () => {
		expect(await assembleRecapContext(db, { userId: strangerId, storyId })).toBeNull();
	});

	it('frames the story and includes the story so far', async () => {
		const text = await assembleRecapContext(db, { userId: ownerId, storyId, sceneId: scene2Id });
		expect(text).not.toBeNull();
		expect(text).toContain('The Tide Below');
		expect(text).toContain('The story so far');
		// scene1 has a summary; recap prefers it over the body.
		expect(text).toContain('Alice and Bram meet.');
		// In-scope entities ride along for grounding.
		expect(text).toContain('Alice');
	});

	it('stops at the focus scene and excludes later scenes', async () => {
		const text = await assembleRecapContext(db, { userId: ownerId, storyId, sceneId: scene1Id });
		expect(text).toContain('Alice and Bram meet.'); // scene1
		expect(text).not.toContain('A calm walk south.'); // scene2, after the focus
	});

	it('recaps the whole story when no scene is given', async () => {
		const text = await assembleRecapContext(db, { userId: ownerId, storyId });
		expect(text).toContain('Alice and Bram meet.');
		expect(text).toContain('A calm walk south.');
	});

	it('falls back to a scene body when it has no summary', async () => {
		await db.update(scenes).set({ summaryMd: null }).where(eq(scenes.id, scene1Id));
		const text = await assembleRecapContext(db, { userId: ownerId, storyId, sceneId: scene1Id });
		expect(text).toContain('Alice met Bram by the Aether gate at dawn.');
	});
});
