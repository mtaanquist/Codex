import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { users } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

process.env.APP_SECRET = process.env.APP_SECRET || 'llm-usage-test-secret';

import {
	withBilledUsage,
	type HttpRequest,
	type Provider
} from '../../src/lib/server/llm/providers/types';

const { saveAccountLlmConfig } = await import('../../src/lib/server/llm/config');
const { complete, completeDetailed, stream } = await import('../../src/lib/server/llm/gateway');
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
		expect(summary.totals).toEqual({
			requests: 1,
			promptTokens: 100,
			completionTokens: 20,
			estimatedRequests: 0,
			webSearchRequests: 0
		});
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

	// The chat route stops reading at done (and at error), so the generator
	// never runs past its loop; the row must land anyway.
	it('logs a streamed turn whose caller stops reading at done (#1102)', async () => {
		await configure();
		const provider: Provider = {
			async *chatStream() {
				yield { type: 'token', text: 'hi' };
				yield { type: 'usage', usage: { promptTokens: 7, completionTokens: 1 } };
				yield { type: 'done' };
				yield { type: 'token', text: 'never read' };
			},
			async respond() {
				return { content: '', toolCalls: [] };
			},
			async listModels() {
				return [];
			}
		};
		for await (const event of stream(
			db,
			{ userId, role: 'chat', messages: [] },
			{ provider, http: noHttp }
		)) {
			if (event.type === 'done') break;
		}
		const summary = await recentAssistantUsage(db, userId);
		expect(summary.recent).toHaveLength(1);
		expect(summary.recent[0]).toMatchObject({ promptTokens: 7, completionTokens: 1 });
	});

	it('logs a streamed turn that was cancelled partway (#1102)', async () => {
		await configure();
		const provider: Provider = {
			async *chatStream() {
				yield { type: 'token', text: 'hi' };
				throw Object.assign(new Error('aborted'), { name: 'AbortError' });
			},
			async respond() {
				return { content: '', toolCalls: [] };
			},
			async listModels() {
				return [];
			}
		};
		await expect(async () => {
			for await (const event of stream(
				db,
				{ userId, role: 'chat', messages: [] },
				{ provider, http: noHttp }
			)) {
				void event;
			}
		}).rejects.toThrow('aborted');
		const summary = await recentAssistantUsage(db, userId);
		expect(summary.recent).toHaveLength(1);
		expect(summary.recent[0]).toMatchObject({ promptTokens: null, completionTokens: null });
	});

	it('marks an estimated attempt in the log, apart from reported counts (#1116)', async () => {
		await configure();
		let attempts = 0;
		const provider: Provider = {
			async *chatStream() {
				yield { type: 'done' };
			},
			async respond() {
				attempts += 1;
				if (attempts === 1) {
					throw withBilledUsage(new Error('Endpoint returned 529: overloaded'), {
						promptTokens: 50,
						completionTokens: 16384,
						estimated: true
					});
				}
				return {
					content: 'ok',
					toolCalls: [],
					usage: { promptTokens: 50, completionTokens: 10, webSearchRequests: 2 }
				};
			},
			async listModels() {
				return [];
			}
		};
		await complete(
			db,
			{ userId, role: 'chat', messages: [] },
			{ provider, http: noHttp, sleep: async () => {} }
		);
		const summary = await recentAssistantUsage(db, userId);
		const [reported, estimated] = summary.recent;
		expect(estimated).toMatchObject({ completionTokens: 16384, estimated: true });
		expect(reported).toMatchObject({
			completionTokens: 10,
			estimated: false,
			webSearchRequests: 2
		});
		expect(summary.totals).toMatchObject({
			requests: 2,
			estimatedRequests: 1,
			webSearchRequests: 2
		});
	});

	it('sums the cache shares of a failed attempt and its retry (#1274)', async () => {
		await configure();
		let attempts = 0;
		const provider: Provider = {
			async *chatStream() {
				yield { type: 'done' };
			},
			async respond() {
				attempts += 1;
				if (attempts === 1) {
					throw withBilledUsage(new Error('Endpoint returned 529: overloaded'), {
						promptTokens: 100,
						completionTokens: 1,
						cacheWriteTokens: 80,
						cacheWrite1hTokens: 50
					});
				}
				return {
					content: 'ok',
					toolCalls: [],
					usage: {
						promptTokens: 100,
						completionTokens: 10,
						cachedPromptTokens: 70,
						cacheWriteTokens: 20,
						cacheWrite1hTokens: 5
					}
				};
			},
			async listModels() {
				return [];
			}
		};
		const result = await completeDetailed(
			db,
			{ userId, role: 'chat', messages: [] },
			{ provider, http: noHttp, sleep: async () => {} }
		);
		expect(result.usage).toEqual({
			promptTokens: 200,
			completionTokens: 11,
			cachedPromptTokens: 70,
			cacheWriteTokens: 100,
			cacheWrite1hTokens: 55
		});
	});
});

// Structured logs are the only output here; the tests read them off stdout.
function captureLogs(): { lines: () => Record<string, unknown>[]; restore: () => void } {
	const captured: Record<string, unknown>[] = [];
	const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
		if (typeof line === 'string' && line.startsWith('{')) {
			captured.push(JSON.parse(line) as Record<string, unknown>);
		}
	});
	return { lines: () => captured, restore: () => spy.mockRestore() };
}

describe('estimate-vs-actual token accounting', () => {
	it('logs the estimate against the endpoint report for a turn that had one', async () => {
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
		const logs = captureLogs();
		try {
			await complete(
				db,
				{ userId, role: 'chat', messages: [{ role: 'user', content: 'hello there' }] },
				{ provider, http: noHttp }
			);
		} finally {
			logs.restore();
		}
		const line = logs.lines().find((l) => l.event === 'assistant.usage.estimate');
		expect(line).toBeDefined();
		expect(line).toMatchObject({ model: 'chat-model', actual: 100 });
		// The persona prompt alone puts the estimate well above zero, and the
		// logged ratio is the two counts divided.
		const estimated = line!.estimated as number;
		expect(estimated).toBeGreaterThan(0);
		expect(line!.ratio).toBe(Math.round((estimated / 100) * 100) / 100);
		// The row itself is unchanged: no estimate column, phase one is logs only.
		const summary = await recentAssistantUsage(db, userId);
		expect(summary.recent[0]).toMatchObject({ promptTokens: 100, completionTokens: 20 });
	});

	it('logs nothing when the endpoint reported no prompt tokens', async () => {
		const logs = captureLogs();
		try {
			await recordAssistantUsage(db, { userId, role: 'chat', model: 'm', usage: undefined });
			await recordAssistantUsage(db, {
				userId,
				role: 'chat',
				model: 'm',
				usage: { promptTokens: 0, completionTokens: 4 },
				estimatedPromptTokens: 40
			});
		} finally {
			logs.restore();
		}
		expect(logs.lines().some((l) => l.event === 'assistant.usage.estimate')).toBe(false);
	});

	it('reports the ratio of estimate to report', async () => {
		const logs = captureLogs();
		try {
			await recordAssistantUsage(db, {
				userId,
				role: 'chat',
				model: 'm',
				usage: { promptTokens: 500, completionTokens: 10 },
				estimatedPromptTokens: 425
			});
		} finally {
			logs.restore();
		}
		expect(logs.lines().find((l) => l.event === 'assistant.usage.estimate')).toMatchObject({
			model: 'm',
			estimated: 425,
			actual: 500,
			ratio: 0.85
		});
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
			usage: {
				promptTokens: 30,
				completionTokens: 8,
				cachedPromptTokens: 4,
				cacheWriteTokens: 20,
				cacheWrite1hTokens: 12
			}
		});
		await recordAssistantUsage(db, {
			userId,
			role: 'chat',
			model: 'b',
			usage: { promptTokens: 5, completionTokens: 1 }
		});
		const summary = await recentAssistantUsage(db, userId);
		expect(summary.totals).toEqual({
			requests: 3,
			promptTokens: 45,
			completionTokens: 11,
			estimatedRequests: 0,
			webSearchRequests: 0
		});
		expect(summary.byModel.sort((x, y) => x.model.localeCompare(y.model))).toEqual([
			{
				model: 'a',
				promptTokens: 40,
				completionTokens: 10,
				cachedPromptTokens: 4,
				cacheWriteTokens: 20,
				cacheWrite1hTokens: 12
			},
			{
				model: 'b',
				promptTokens: 5,
				completionTokens: 1,
				cachedPromptTokens: 0,
				cacheWriteTokens: 0,
				cacheWrite1hTokens: 0
			}
		]);
	});

	it('keeps the cache shares on a row, and null where none were reported (#1274)', async () => {
		await recordAssistantUsage(db, {
			userId,
			role: 'chat',
			model: 'a',
			usage: { promptTokens: 10, completionTokens: 2 }
		});
		await recordAssistantUsage(db, {
			userId,
			role: 'chat',
			model: 'a',
			usage: {
				promptTokens: 100,
				completionTokens: 5,
				cachedPromptTokens: 30,
				cacheWriteTokens: 60,
				cacheWrite1hTokens: 60
			}
		});
		const { recent } = await recentAssistantUsage(db, userId);
		expect(recent[0]).toMatchObject({
			promptTokens: 100,
			cachedPromptTokens: 30,
			cacheWriteTokens: 60,
			cacheWrite1hTokens: 60
		});
		expect(recent[1]).toMatchObject({
			cachedPromptTokens: null,
			cacheWriteTokens: null,
			cacheWrite1hTokens: null
		});
	});

	it('pages fifty at a time, newest first', async () => {
		for (let i = 0; i < 55; i++) {
			await recordAssistantUsage(db, {
				userId,
				role: 'chat',
				model: `m${i}`,
				usage: { promptTokens: i, completionTokens: 0 }
			});
		}
		const first = await recentAssistantUsage(db, userId, 0);
		expect(first.recent).toHaveLength(50);
		expect(first.page).toBe(0);
		expect(first.hasMore).toBe(true);
		const second = await recentAssistantUsage(db, userId, 1);
		expect(second.recent).toHaveLength(5);
		expect(second.hasMore).toBe(false);
		// No overlap between pages; totals are page-independent.
		const ids = new Set([...first.recent, ...second.recent].map((r) => r.id));
		expect(ids.size).toBe(55);
		expect(second.totals.requests).toBe(55);
		// A page past the end is empty, and a negative page clamps to the first.
		expect((await recentAssistantUsage(db, userId, 9)).recent).toHaveLength(0);
		expect((await recentAssistantUsage(db, userId, -3)).page).toBe(0);
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
