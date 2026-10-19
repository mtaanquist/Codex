import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { stories, universes, users } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import type { GatewayDeps } from '../../src/lib/server/llm/gateway';
import type { ChatMessage, HttpRequest, Provider } from '../../src/lib/server/llm/providers/types';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

process.env.APP_SECRET = process.env.APP_SECRET || 'chat-summary-test-secret';

const { saveAccountLlmConfig } = await import('../../src/lib/server/llm/config');
const { clearChat } = await import('../../src/lib/server/llm/chat-history');
const { fitChatWithSummary, getChatSummary, coveredAnchor } =
	await import('../../src/lib/server/llm/chat-summary');

// Records what the utility role was asked and answers with a numbered summary.
let prompts: string[] = [];
let failing = false;
const stubProvider: Provider = {
	async *chatStream() {
		yield { type: 'done' };
	},
	async respond(req) {
		if (failing) throw new Error('endpoint down');
		prompts.push(req.messages[req.messages.length - 1].content);
		return { content: `SUMMARY-${prompts.length}`, toolCalls: [] };
	},
	async listModels() {
		return [];
	}
};
const noHttp: HttpRequest = async () => {
	throw new Error('the injected provider should not call the transport');
};
const deps: GatewayDeps = { provider: stubProvider, http: noHttp };

let pool: pg.Pool;
let db: Database;
let userId: string;
let storyId: string;

function conversation(count: number): ChatMessage[] {
	return Array.from({ length: count }, (_, i) => ({
		role: i % 2 === 0 ? 'user' : 'assistant',
		content: `turn ${i} ` + 'x'.repeat(392)
	}));
}

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	prompts = [];
	failing = false;
	await pool.query(
		'truncate table assistant_chat_summaries, assistant_chat_messages, stories, universes, users cascade'
	);
	const [user] = await db
		.insert(users)
		.values({ email: 'w@example.com', displayName: 'Wren', passwordHash: 'x', role: 'user' })
		.returning({ id: users.id });
	userId = user.id;
	await saveAccountLlmConfig(db, userId, {
		enabled: true,
		assistantName: '',
		persona: 'balanced',
		endpoint: 'https://api.example.com/v1',
		apiKey: 'sk',
		models: { chat: 'chat-model' },
		toolCallBudget: 8
	});
	const [universe] = await db
		.insert(universes)
		.values({ ownerId: userId, name: 'Aldermoor' })
		.returning({ id: universes.id });
	const [story] = await db
		.insert(stories)
		.values({ universeId: universe.id, ownerId: userId, title: 'The Tide Below' })
		.returning({ id: stories.id });
	storyId = story.id;
});

afterAll(async () => {
	await pool.end();
});

describe('fitChatWithSummary', () => {
	it('sends the turns as they are while they fit', async () => {
		const turns = conversation(4);
		const result = await fitChatWithSummary(
			db,
			{ userId, scope: { storyId }, turns, budgetTokens: 1000 },
			deps
		);
		expect(result).toEqual({ messages: turns, summarised: false });
		expect(prompts).toHaveLength(0);
	});

	it('summarises the overflow, stores it, and reuses it on the next request', async () => {
		const scope = { storyId };
		const first = conversation(12);
		const result = await fitChatWithSummary(
			db,
			{ userId, scope, turns: first, budgetTokens: 1000 },
			deps
		);
		expect(result.summarised).toBe(true);
		expect(result.messages[0].role).toBe('system');
		expect(result.messages[0].content).toContain('SUMMARY-1');
		expect(result.messages.slice(1)).toEqual(first.slice(8));
		expect(prompts[0]).toContain('turn 0');
		expect(prompts[0]).not.toContain('turn 8');
		expect(await getChatSummary(db, userId, scope)).toEqual({
			summary: 'SUMMARY-1',
			coveredDigest: coveredAnchor(first, 8)
		});

		// Two more turns still fit beside the summary: no new utility call.
		const second = conversation(14);
		const again = await fitChatWithSummary(
			db,
			{ userId, scope, turns: second, budgetTokens: 1000 },
			deps
		);
		expect(prompts).toHaveLength(1);
		expect(again.messages.slice(1)).toEqual(second.slice(8));

		// More turns fall out: the refresh carries the old summary forward.
		const third = conversation(20);
		await fitChatWithSummary(db, { userId, scope, turns: third, budgetTokens: 1000 }, deps);
		expect(prompts).toHaveLength(2);
		expect(prompts[1]).toContain('SUMMARY-1');
		expect(prompts[1]).toContain('turn 8');
		expect(prompts[1]).not.toContain('turn 0 ');
		expect((await getChatSummary(db, userId, scope))?.summary).toBe('SUMMARY-2');
	});

	it('drops the overflow as before when the summary cannot be made', async () => {
		failing = true;
		const turns = conversation(12);
		const result = await fitChatWithSummary(
			db,
			{ userId, scope: { storyId }, turns, budgetTokens: 1000 },
			deps
		);
		expect(result.summarised).toBe(false);
		expect(result.messages).toEqual(turns.slice(2));
		expect(await getChatSummary(db, userId, { storyId })).toBeNull();
	});

	it('clearing the conversation clears its summary', async () => {
		const scope = { storyId };
		await fitChatWithSummary(
			db,
			{ userId, scope, turns: conversation(12), budgetTokens: 1000 },
			deps
		);
		await clearChat(db, userId, scope);
		expect(await getChatSummary(db, userId, scope)).toBeNull();
	});
});
