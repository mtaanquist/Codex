import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
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

process.env.APP_SECRET = process.env.APP_SECRET || 'review-focus-test-secret';

import type {
	ChatMessage,
	Provider,
	ProviderToolCall
} from '../../src/lib/server/llm/providers/types';

const { saveAccountLlmConfig } = await import('../../src/lib/server/llm/config');
const { reviewStoryScenes } = await import('../../src/lib/server/llm/scene-review');
const { createThread } = await import('../../src/lib/server/review');

let pool: pg.Pool;
let db: Database;
let userId: string;
let universeId: string;

// Records every request's messages and answers with plain text (no tool
// calls), so a review run completes in one provider turn.
function recordingProvider(): { provider: Provider; seen: ChatMessage[][] } {
	const seen: ChatMessage[][] = [];
	const provider: Provider = {
		async *chatStream() {
			yield { type: 'done' };
		},
		async respond(req) {
			seen.push(req.messages);
			return { content: 'no notes', toolCalls: [] };
		},
		async listModels() {
			return [];
		}
	};
	return { provider, seen };
}

// A provider scripted with a queue of turns, so the agent loop can stage notes.
function scriptedProvider(turns: { content: string; toolCalls?: ProviderToolCall[] }[]): Provider {
	return {
		async *chatStream() {
			yield { type: 'done' };
		},
		async respond() {
			const turn = turns.shift() ?? { content: '' };
			return { content: turn.content, toolCalls: turn.toolCalls ?? [] };
		},
		async listModels() {
			return [];
		}
	};
}

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query(
		'truncate table review_suggestions, review_comments, review_threads, scenes, chapters, stories, universes, users cascade'
	);
	const [user] = await db
		.insert(users)
		.values({ email: 'r@example.com', displayName: 'Rae', passwordHash: 'x', role: 'user' })
		.returning({ id: users.id });
	userId = user.id;
	const [universe] = await db
		.insert(universes)
		.values({ ownerId: userId, name: 'U' })
		.returning({ id: universes.id });
	universeId = universe.id;
	// World material, so a pass that ships the world tiers can be told apart
	// from one that does not.
	const [category] = await db
		.insert(entityCategories)
		.values({ universeId, ownerId: userId, name: 'Lore', color: '#888', sortOrder: 0 })
		.returning({ id: entityCategories.id });
	await db.insert(loreEntries).values({
		universeId,
		ownerId: userId,
		categoryId: category.id,
		title: 'Creation Myth',
		summaryMd: 'How the kingdom drowned.',
		activationMode: 'always'
	});
	await db.insert(notes).values({
		ownerId: userId,
		universeId,
		title: 'Plot',
		bodyMd: 'The bell tolls a betrayal.'
	});
	await saveAccountLlmConfig(db, userId, {
		enabled: true,
		assistantName: '',
		persona: 'balanced',
		endpoint: 'https://api.example.com/v1',
		apiKey: 'sk',
		models: { reviewer: 'review-model' },
		toolCallBudget: 8
	});
});

afterAll(async () => {
	await pool.end();
});

async function seedStory(sceneCount: number): Promise<string> {
	const [story] = await db
		.insert(stories)
		.values({ universeId, ownerId: userId, title: 'S' })
		.returning({ id: stories.id });
	for (let i = 0; i < sceneCount; i++) {
		await db.insert(scenes).values({
			storyId: story.id,
			globalPosition: i + 1,
			title: `Scene ${i + 1}`,
			bodyMd: `Body of scene ${i + 1}.`
		});
	}
	return story.id;
}

const userText = (messages: ChatMessage[]) =>
	messages
		.filter((m) => m.role === 'user')
		.map((m) => m.content)
		.join('\n');

const systemText = (messages: ChatMessage[]) =>
	messages
		.filter((m) => m.role === 'system')
		.map((m) => m.content)
		.join('\n');

describe('reviewStoryScenes note counts', () => {
	it('counts the notes the run staged, and only those', async () => {
		const storyId = await seedStory(1);
		const [scene] = await db.select({ id: scenes.id }).from(scenes);
		// A note already on the scene from an earlier pass; the run must not
		// count it, only what it stages itself.
		await createThread(db, {
			storyId,
			sceneId: scene.id,
			anchor: null,
			author: { assistant: true },
			body: 'An older note.'
		});
		const provider = scriptedProvider([
			{
				content: '',
				toolCalls: [
					{ id: 'r1', name: 'get_scene', arguments: JSON.stringify({ sceneId: scene.id }) },
					{
						id: 'w1',
						name: 'leave_comment',
						arguments: JSON.stringify({ sceneId: scene.id, comment: 'The pacing drags.' })
					},
					{
						id: 'w2',
						name: 'suggest_edit',
						arguments: JSON.stringify({
							sceneId: scene.id,
							original: 'Body of scene 1.',
							replacement: 'The body of scene one.'
						})
					}
				]
			},
			{ content: 'Two notes left.' }
		]);
		const result = await reviewStoryScenes(db, { userId, storyId }, { provider });
		expect(result.reviewed).toBe(1);
		expect(result.notes).toBe(2);
	});

	it('reports no notes for a run that stages nothing', async () => {
		const storyId = await seedStory(2);
		const { provider } = recordingProvider();
		const result = await reviewStoryScenes(db, { userId, storyId }, { provider });
		expect(result.notes).toBe(0);
	});
});

describe('reviewStoryScenes categories', () => {
	it('an empty category set reviews each scene sparingly with no consistency run', async () => {
		const storyId = await seedStory(2);
		const { provider, seen } = recordingProvider();
		const result = await reviewStoryScenes(db, { userId, storyId }, { provider });
		expect(result.reviewed).toBe(2);
		expect(seen).toHaveLength(2);
		for (const messages of seen) {
			expect(userText(messages)).toContain('specific and sparing');
		}
	});

	it('all three categories sweep every scene, then run the cross-scene pass', async () => {
		const storyId = await seedStory(3);
		const { provider, seen } = recordingProvider();
		const result = await reviewStoryScenes(
			db,
			{ userId, storyId, categories: ['mechanics', 'prose', 'lore'] },
			{ provider }
		);
		expect(result.reviewed).toBe(3);
		expect(seen).toHaveLength(4);
		for (const messages of seen.slice(0, 3)) {
			expect(userText(messages)).toContain('full copyedit pass');
		}
		const consistency = userText(seen[3]);
		expect(consistency).toContain('cross-scene consistency pass');
		expect(consistency).toContain('Scene 1');
		expect(consistency).toContain('Scene 3');
	});

	it('a single category sweeps each scene without the cross-scene pass', async () => {
		const storyId = await seedStory(3);
		const { provider, seen } = recordingProvider();
		await reviewStoryScenes(db, { userId, storyId, categories: ['mechanics'] }, { provider });
		expect(seen).toHaveLength(3);
		for (const messages of seen) {
			expect(userText(messages)).toContain('spelling and grammar pass');
		}
	});

	it('sends one identical system message for every scene, with the scene text in the user turn', async () => {
		const storyId = await seedStory(3);
		const { provider, seen } = recordingProvider();
		await reviewStoryScenes(db, { userId, storyId }, { provider });
		expect(seen).toHaveLength(3);
		const systems = seen.map(systemText);
		// The prefix a prompt cache hashes must not change between scenes.
		expect(new Set(systems).size).toBe(1);
		// Nothing scene-local rides in it; the scene text is in the user turn,
		// and the reviewer is told not to fetch it again.
		expect(systems[0]).not.toContain('Body of scene 1.');
		for (let i = 0; i < 3; i++) {
			const user = userText(seen[i]);
			expect(user).toContain(`Body of scene ${i + 1}.`);
			expect(user).toContain('Do not call get_scene');
		}
	});

	it('leaves the world out of a mechanics-only pass', async () => {
		const storyId = await seedStory(2);
		const { provider, seen } = recordingProvider();
		await reviewStoryScenes(db, { userId, storyId, categories: ['mechanics'] }, { provider });
		for (const messages of seen) {
			const whole = systemText(messages) + userText(messages);
			expect(whole).not.toContain('Creation Myth');
			expect(whole).not.toContain('The bell tolls a betrayal.');
		}
		// The frame stays: it carries the story, the world, and the style notes.
		expect(systemText(seen[0])).toContain('# Story: S');
		// The scene itself still rides in the user turn.
		expect(userText(seen[0])).toContain('Body of scene 1.');
	});

	it('leaves the world out of a prose and mechanics pass', async () => {
		const storyId = await seedStory(1);
		const { provider, seen } = recordingProvider();
		await reviewStoryScenes(
			db,
			{ userId, storyId, categories: ['prose', 'mechanics'] },
			{ provider }
		);
		const whole = systemText(seen[0]) + userText(seen[0]);
		expect(whole).not.toContain('Creation Myth');
		expect(whole).not.toContain('The bell tolls a betrayal.');
	});

	it('keeps the world for a pass that checks lore', async () => {
		const storyId = await seedStory(1);
		const { provider, seen } = recordingProvider();
		await reviewStoryScenes(db, { userId, storyId, categories: ['lore'] }, { provider });
		expect(systemText(seen[0])).toContain('The bell tolls a betrayal.');
		expect(userText(seen[0])).toContain('Creation Myth');
	});

	it('keeps the world for the sparing pass with no categories', async () => {
		const storyId = await seedStory(1);
		const { provider, seen } = recordingProvider();
		await reviewStoryScenes(db, { userId, storyId }, { provider });
		expect(systemText(seen[0])).toContain('The bell tolls a betrayal.');
		expect(userText(seen[0])).toContain('Creation Myth');
	});

	it('sends one identical system message across a run with categories set', async () => {
		const storyId = await seedStory(3);
		const { provider, seen } = recordingProvider();
		await reviewStoryScenes(db, { userId, storyId, categories: ['mechanics'] }, { provider });
		expect(new Set(seen.map(systemText)).size).toBe(1);
	});

	it('skips the consistency pass for a single-scene story', async () => {
		const storyId = await seedStory(1);
		const { provider, seen } = recordingProvider();
		await reviewStoryScenes(
			db,
			{ userId, storyId, categories: ['mechanics', 'prose', 'lore'] },
			{ provider }
		);
		expect(seen).toHaveLength(1);
	});
});
