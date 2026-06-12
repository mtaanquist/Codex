import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { scenes, stories, universes, users } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

process.env.APP_SECRET = process.env.APP_SECRET || 'review-focus-test-secret';

import type { ChatMessage, Provider } from '../../src/lib/server/llm/providers/types';

const { saveAccountLlmConfig } = await import('../../src/lib/server/llm/config');
const { reviewStoryScenes } = await import('../../src/lib/server/llm/scene-review');

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

describe('reviewStoryScenes focus', () => {
	it('the default pass reviews each scene sparingly with no consistency run', async () => {
		const storyId = await seedStory(2);
		const { provider, seen } = recordingProvider();
		const result = await reviewStoryScenes(db, { userId, storyId }, { provider });
		expect(result.reviewed).toBe(2);
		expect(seen).toHaveLength(2);
		for (const messages of seen) {
			expect(userText(messages)).toContain('specific and sparing');
		}
	});

	it('a full review sweeps every scene by category, then runs the cross-scene pass', async () => {
		const storyId = await seedStory(3);
		const { provider, seen } = recordingProvider();
		const result = await reviewStoryScenes(db, { userId, storyId, focus: 'full' }, { provider });
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

	it('skips the consistency pass for a single-scene story', async () => {
		const storyId = await seedStory(1);
		const { provider, seen } = recordingProvider();
		await reviewStoryScenes(db, { userId, storyId, focus: 'full' }, { provider });
		expect(seen).toHaveLength(1);
	});
});
