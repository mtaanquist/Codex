import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { users } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

process.env.APP_SECRET = process.env.APP_SECRET || 'llm-usage-test-secret';

import type { HttpRequest, Provider } from '../../src/lib/server/llm/providers/types';

const { saveAccountLlmConfig } = await import('../../src/lib/server/llm/config');
const { complete, stream } = await import('../../src/lib/server/llm/gateway');
const { recentAssistantUsage, recordAssistantUsage } =
	await import('../../src/lib/server/llm/usage');

let pool: pg.Pool;
let db: Database;
let userId: string;

const noHttp: HttpRequest = async () => {
	throw new Error('the injected provider should not call the transport');
};

async function configure() {
	await saveAccountLlmConfig(db, userId, {
		enabled: true,
		assistantName: '',
		persona: 'balanced',
		endpoint: 'https://api.example.com/v1',
		apiKey: 'sk',
		models: { chat: 'chat-model' },
		toolCallBudget: 8
	});
}

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query('truncate table assistant_usage, app_settings, users cascade');
	const [user] = await db
		.insert(users)
		.values({ email: 'w@example.com', displayName: 'Wren', passwordHash: 'x', role: 'user' })
		.returning({ id: users.id });
	userId = user.id;
});

afterAll(async () => {
	await pool.end();
});

describe('gateway usage recording', () => {
	it('logs a row with the token counts a buffered turn reported', async () => {
		await configure();
		const provider: Provider = {
			async *chatStream() {
				yield { type: 'done' };
			},
			async respond() {
				return {
					content: 'ok',
					toolCalls: [],
					usage: { promptTokens: 100, completionTokens: 20 }
				};
			},
			async listModels() {
				return [];
			}
		};
		await complete(db, { userId, role: 'chat', messages: [] }, { provider, http: noHttp });
		const summary = await recentAssistantUsage(db, userId);
		expect(summary.recent).toHaveLength(1);
		expect(summary.recent[0]).toMatchObject({
			role: 'chat',
			model: 'chat-model',
			promptTokens: 100,
			completionTokens: 20
		});
		expect(summary.totals).toEqual({ requests: 1, promptTokens: 100, completionTokens: 20 });
	});

	it('consumes the streamed usage frame: logged, never forwarded', async () => {
		await configure();
		const provider: Provider = {
			async *chatStream() {
				yield { type: 'token', text: 'hi' };
				yield { type: 'usage', usage: { promptTokens: 7, completionTokens: 1 } };
				yield { type: 'done' };
			},
			async respond() {
				return { content: '', toolCalls: [] };
			},
			async listModels() {
				return [];
			}
		};
		const events = [];
		for await (const event of stream(
			db,
			{ userId, role: 'chat', messages: [] },
			{ provider, http: noHttp }
		)) {
			events.push(event);
		}
		expect(events).toEqual([{ type: 'token', text: 'hi' }, { type: 'done' }]);
		const summary = await recentAssistantUsage(db, userId);
		expect(summary.recent[0]).toMatchObject({ promptTokens: 7, completionTokens: 1 });
	});

	it('still logs the request when the endpoint reported no counts', async () => {
		await configure();
		const provider: Provider = {
			async *chatStream() {
				yield { type: 'done' };
			},
			async respond() {
				return { content: 'ok', toolCalls: [] };
			},
			async listModels() {
				return [];
			}
		};
		await complete(db, { userId, role: 'chat', messages: [] }, { provider, http: noHttp });
		const summary = await recentAssistantUsage(db, userId);
		expect(summary.recent[0]).toMatchObject({ promptTokens: null, completionTokens: null });
		expect(summary.totals.requests).toBe(1);
	});
});

describe('recentAssistantUsage', () => {
	it('sums thirty-day totals per model for cost estimates', async () => {
		await recordAssistantUsage(db, {
			userId,
			role: 'chat',
			model: 'a',
			usage: { promptTokens: 10, completionTokens: 2 }
		});
		await recordAssistantUsage(db, {
			userId,
			role: 'coauthor',
			model: 'a',
			usage: { promptTokens: 30, completionTokens: 8 }
		});
		await recordAssistantUsage(db, {
			userId,
			role: 'chat',
			model: 'b',
			usage: { promptTokens: 5, completionTokens: 1 }
		});
		const summary = await recentAssistantUsage(db, userId);
		expect(summary.totals).toEqual({ requests: 3, promptTokens: 45, completionTokens: 11 });
		expect(summary.byModel.sort((x, y) => x.model.localeCompare(y.model))).toEqual([
			{ model: 'a', promptTokens: 40, completionTokens: 10 },
			{ model: 'b', promptTokens: 5, completionTokens: 1 }
		]);
	});

	it('only counts the requesting user', async () => {
		const [other] = await db
			.insert(users)
			.values({ email: 'o@example.com', displayName: 'O', passwordHash: 'x', role: 'user' })
			.returning({ id: users.id });
		await recordAssistantUsage(db, {
			userId: other.id,
			role: 'chat',
			model: 'a',
			usage: { promptTokens: 9, completionTokens: 9 }
		});
		const summary = await recentAssistantUsage(db, userId);
		expect(summary.totals.requests).toBe(0);
		expect(summary.recent).toHaveLength(0);
	});
});
