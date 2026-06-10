import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	assistantChatMessages,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

process.env.APP_SECRET = process.env.APP_SECRET || 'chat-history-test-secret';

const { appendChat, clearChat, listChat } = await import('../../src/lib/server/llm/chat-history');
const { deleteStory } = await import('../../src/lib/server/story-delete');
const { purgeAccount } = await import('../../src/lib/server/account-deletion');

let pool: pg.Pool;
let db: Database;
let userId: string;
let storyId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query(
		'truncate table assistant_chat_messages, revisions, scenes, chapters, stories, universes, users cascade'
	);
	const [user] = await db
		.insert(users)
		.values({ email: 'w@example.com', displayName: 'Wren', passwordHash: 'x', role: 'user' })
		.returning({ id: users.id });
	userId = user.id;
	const [universe] = await db
		.insert(universes)
		.values({ ownerId: userId, name: 'U' })
		.returning({ id: universes.id });
	const [story] = await db
		.insert(stories)
		.values({ universeId: universe.id, ownerId: userId, title: 'S' })
		.returning({ id: stories.id });
	storyId = story.id;
	await db.insert(scenes).values({ storyId, globalPosition: 1, bodyMd: 'Once.' });
});

afterAll(async () => {
	await pool.end();
});

describe('chat history', () => {
	it('round-trips turns with their meta in order', async () => {
		await appendChat(db, userId, storyId, {
			role: 'user',
			content: 'Why is this tense?',
			meta: { reference: { sceneId: storyId, text: 'The rain fell.' } }
		});
		await appendChat(db, userId, storyId, {
			role: 'assistant',
			content: 'Because of the storm.',
			meta: {
				proposals: [{ sceneId: storyId, sceneTitle: null, before: 'The', rationale: 'why' }]
			}
		});
		const stored = await listChat(db, userId, storyId);
		expect(stored.map((m) => m.role)).toEqual(['user', 'assistant']);
		expect(stored[0].meta?.reference?.text).toBe('The rain fell.');
		expect(stored[1].meta?.proposals?.[0].before).toBe('The');
	});

	it('skips empty turns and is scoped per user and story', async () => {
		await appendChat(db, userId, storyId, { role: 'assistant', content: '   ', meta: null });
		expect(await listChat(db, userId, storyId)).toHaveLength(0);
		const [other] = await db
			.insert(users)
			.values({ email: 'o@example.com', displayName: 'Other', passwordHash: 'x', role: 'user' })
			.returning({ id: users.id });
		await appendChat(db, userId, storyId, { role: 'user', content: 'mine', meta: null });
		expect(await listChat(db, other.id, storyId)).toHaveLength(0);
	});

	it('trims the oldest turns past the cap', async () => {
		for (let i = 0; i < 205; i++) {
			await appendChat(db, userId, storyId, { role: 'user', content: `turn ${i}`, meta: null });
		}
		const stored = await listChat(db, userId, storyId);
		expect(stored.length).toBeLessThanOrEqual(200);
		expect(stored[stored.length - 1].content).toBe('turn 204');
		expect(stored[0].content).not.toBe('turn 0');
	});

	it('clears on request', async () => {
		await appendChat(db, userId, storyId, { role: 'user', content: 'hello', meta: null });
		await clearChat(db, userId, storyId);
		expect(await listChat(db, userId, storyId)).toHaveLength(0);
	});

	it('goes with the story and with the account', async () => {
		await appendChat(db, userId, storyId, { role: 'user', content: 'hello', meta: null });
		await deleteStory(db, storyId, userId);
		const afterStory = await db
			.select()
			.from(assistantChatMessages)
			.where(eq(assistantChatMessages.userId, userId));
		expect(afterStory).toHaveLength(0);

		// A second story's transcript goes with the whole account.
		const [universe] = await db.select().from(universes);
		const [again] = await db
			.insert(stories)
			.values({ universeId: universe.id, ownerId: userId, title: 'S2' })
			.returning({ id: stories.id });
		await appendChat(db, userId, again.id, { role: 'user', content: 'still here', meta: null });
		await purgeAccount(db, userId, null);
		const afterPurge = await db.select().from(assistantChatMessages);
		expect(afterPurge).toHaveLength(0);
	});
});
