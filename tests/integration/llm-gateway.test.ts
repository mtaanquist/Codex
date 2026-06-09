import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { universes, users } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

process.env.APP_SECRET = process.env.APP_SECRET || 'llm-gateway-test-secret';

import type { GatewayDeps } from '../../src/lib/server/llm/gateway';
import type { HttpRequest, Provider, StreamEvent } from '../../src/lib/server/llm/providers/types';

const { saveAccountLlmConfig } = await import('../../src/lib/server/llm/config');
const { complete, stream, AssistantDisabledError } =
	await import('../../src/lib/server/llm/gateway');

let pool: pg.Pool;
let db: Database;
let userId: string;

// A provider that records the request and emits canned events, so the gateway's
// resolve -> pick model -> stream path is exercised without a network.
let captured: { model: string } | null = null;
const stubProvider: Provider = {
	async *chatStream(req) {
		captured = { model: req.model };
		yield { type: 'token', text: `[${req.model}]` };
		yield { type: 'done' };
	},
	async complete(req) {
		captured = { model: req.model };
		return `done:${req.model}`;
	},
	async probe() {
		return { ok: true, supportsStreaming: true, supportsTools: false };
	}
};
const noHttp: HttpRequest = async () => {
	throw new Error('the injected provider should not call the transport');
};
const stubDeps: GatewayDeps = { provider: stubProvider, http: noHttp };

async function drain(events: AsyncIterable<StreamEvent>) {
	const out: StreamEvent[] = [];
	for await (const event of events) out.push(event);
	return out;
}

async function configure(enabled: boolean) {
	await saveAccountLlmConfig(db, userId, {
		enabled,
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
	captured = null;
	await pool.query('truncate table app_settings, stories, universes, users cascade');
	const [user] = await db
		.insert(users)
		.values({ email: 'w@example.com', displayName: 'Wren', passwordHash: 'x', role: 'user' })
		.returning({ id: users.id });
	userId = user.id;
	await db.insert(universes).values({ ownerId: userId, name: 'U' });
});

afterAll(async () => {
	await pool.end();
});

describe('gateway gating', () => {
	it('streams provider tokens when the account is enabled', async () => {
		await configure(true);
		const events = await drain(stream(db, { userId, role: 'chat', messages: [] }, stubDeps));
		expect(events).toEqual([{ type: 'token', text: '[chat-model]' }, { type: 'done' }]);
	});

	it('falls back to the chat model when a role has none set', async () => {
		await configure(true);
		await drain(stream(db, { userId, role: 'continuation', messages: [] }, stubDeps));
		expect(captured?.model).toBe('chat-model');
	});

	it('complete returns the buffered text', async () => {
		await configure(true);
		expect(await complete(db, { userId, role: 'chat', messages: [] }, stubDeps)).toBe(
			'done:chat-model'
		);
	});

	it('refuses to stream when the account master is off', async () => {
		await configure(false);
		await expect(
			drain(stream(db, { userId, role: 'chat', messages: [] }, stubDeps))
		).rejects.toBeInstanceOf(AssistantDisabledError);
		expect(captured).toBeNull();
	});

	it('refuses when the Assistant is unconfigured', async () => {
		await expect(
			complete(db, { userId, role: 'chat', messages: [] }, stubDeps)
		).rejects.toBeInstanceOf(AssistantDisabledError);
	});
});

describe('gateway over the real egress guard', () => {
	it('a private endpoint under the default policy yields an egress error event', async () => {
		// Enabled, but pointed at loopback with no egress policy row, so the
		// default block-private applies. The real OpenAI adapter over the real
		// egress transport turns the denial into a clean error event.
		await saveAccountLlmConfig(db, userId, {
			enabled: true,
			endpoint: 'http://127.0.0.1:9/v1',
			apiKey: '',
			models: { chat: 'm' },
			toolCallBudget: 8
		});
		const events = await drain(stream(db, { userId, role: 'chat', messages: [] }));
		expect(events).toHaveLength(1);
		expect(events[0].type).toBe('error');
		expect(events[0]).toHaveProperty('message');
		expect((events[0] as { message: string }).message.toLowerCase()).toMatch(/block|loopback/);
	});
});
