import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, eq } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	reviewComments,
	reviewThreads,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

process.env.APP_SECRET = process.env.APP_SECRET || 'continuity-test-secret';

import type {
	ChatMessage,
	Provider,
	ProviderToolCall
} from '../../src/lib/server/llm/providers/types';

const { saveAccountLlmConfig } = await import('../../src/lib/server/llm/config');
const { reviewStoryContinuity, reviewUniverseContinuity } =
	await import('../../src/lib/server/llm/scene-review');

let pool: pg.Pool;
let db: Database;
let userId: string;
let universeId: string;

// Answers with plain text and records every request's messages, so a pass
// completes in one provider turn and the test can read what was asked.
function recordingProvider(): { provider: Provider; seen: ChatMessage[][] } {
	const seen: ChatMessage[][] = [];
	const provider: Provider = {
		async *chatStream() {
			yield { type: 'done' };
		},
		async respond(req) {
			seen.push(req.messages);
			return { content: 'all consistent', toolCalls: [] };
		},
		async listModels() {
			return [];
		}
	};
	return { provider, seen };
}

// Plays a fixed script of turns, so a pass can be driven to stage a note through
// leave_comment and then answer.
function scriptedProvider(turns: { content: string; toolCalls?: ProviderToolCall[] }[]): Provider {
	let i = 0;
	return {
		async *chatStream() {
			yield { type: 'done' };
		},
		async respond() {
			const turn = turns[Math.min(i, turns.length - 1)];
			i += 1;
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
		'truncate table review_suggestions, review_comments, review_threads, revisions, scenes, chapters, stories, universes, users cascade'
	);
	const [user] = await db
		.insert(users)
		.values({ email: 'c@example.com', displayName: 'Cee', passwordHash: 'x', role: 'user' })
		.returning({ id: users.id });
	userId = user.id;
	const [universe] = await db
		.insert(universes)
		.values({ ownerId: userId, name: 'U' })
		.returning({ id: universes.id });
	universeId = universe.id;
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

async function seedStory(title: string, sceneTitles: string[], startPosition = 1): Promise<string> {
	const [story] = await db
		.insert(stories)
		.values({ universeId, ownerId: userId, title })
		.returning({ id: stories.id });
	for (let i = 0; i < sceneTitles.length; i++) {
		await db.insert(scenes).values({
			storyId: story.id,
			globalPosition: startPosition + i,
			title: sceneTitles[i],
			bodyMd: `Body of ${sceneTitles[i]}.`
		});
	}
	return story.id;
}

const userText = (messages: ChatMessage[]) =>
	messages
		.filter((m) => m.role === 'user')
		.map((m) => m.content)
		.join('\n');

describe('reviewStoryContinuity', () => {
	it('runs one consistency pass over every scene, with no per-scene passes', async () => {
		await seedStory('S', ['One', 'Two', 'Three']);
		const storyId = (await db.select({ id: stories.id }).from(stories))[0].id;
		const { provider, seen } = recordingProvider();
		const result = await reviewStoryContinuity(db, { userId, storyId }, { provider });

		expect(result.ran).toBe(true);
		expect(result.scenes).toBe(3);
		// Exactly one provider turn: the consistency pass, no per-scene copyedit runs.
		expect(seen).toHaveLength(1);
		const pass = userText(seen[0]);
		expect(pass).toContain('cross-scene consistency pass');
		expect(pass).toContain('One (id:');
		expect(pass).toContain('Three (id:');
	});

	it('skips the pass when the story has fewer than two scenes', async () => {
		await seedStory('S', ['Only']);
		const storyId = (await db.select({ id: stories.id }).from(stories))[0].id;
		const { provider, seen } = recordingProvider();
		const result = await reviewStoryContinuity(db, { userId, storyId }, { provider });

		expect(result.ran).toBe(false);
		expect(result.scenes).toBe(1);
		expect(seen).toHaveLength(0);
	});
});

describe('reviewUniverseContinuity', () => {
	it('lists every story and frames the pass as cross-story', async () => {
		await seedStory('First Light', ['Gate', 'Road'], 1);
		await seedStory('Second Dawn', ['Harbour'], 3);
		const { provider, seen } = recordingProvider();
		const result = await reviewUniverseContinuity(db, { userId, universeId }, { provider });

		expect(result.ran).toBe(true);
		expect(result.scenes).toBe(3);
		expect(seen).toHaveLength(1);
		const pass = userText(seen[0]);
		expect(pass).toContain('universe-wide continuity pass');
		expect(pass).toContain('Story: First Light');
		expect(pass).toContain('Story: Second Dawn');
	});

	it('stages a thread on the owning story even when launched at the universe', async () => {
		// Two stories; the contradiction is anchored on a scene in the first.
		const firstId = await seedStory('First Light', ['Gate', 'Road'], 1);
		await seedStory('Second Dawn', ['Harbour'], 3);
		const [target] = await db
			.select({ id: scenes.id })
			.from(scenes)
			.where(and(eq(scenes.storyId, firstId), eq(scenes.title, 'Gate')));

		const provider = scriptedProvider([
			{
				content: '',
				toolCalls: [
					{
						id: 'c1',
						name: 'leave_comment',
						arguments: JSON.stringify({
							sceneId: target.id,
							comment: 'The harbour is east here but west in Second Dawn.',
							quote: 'Body of Gate.'
						})
					}
				]
			},
			{ content: 'Logged one contradiction.' }
		]);

		const result = await reviewUniverseContinuity(db, { userId, universeId }, { provider });
		expect(result.ran).toBe(true);
		expect(result.notes).toBe(1);

		// The thread lands on the first story's scene, with the first story's id,
		// even though the pass ran at the universe.
		const threads = await db
			.select({ storyId: reviewThreads.storyId, sceneId: reviewThreads.sceneId })
			.from(reviewThreads);
		expect(threads).toHaveLength(1);
		expect(threads[0].storyId).toBe(firstId);
		expect(threads[0].sceneId).toBe(target.id);

		const comments = await db.select({ assistant: reviewComments.assistant }).from(reviewComments);
		expect(comments).toHaveLength(1);
		expect(comments[0].assistant).toBe(true);
	});
});
