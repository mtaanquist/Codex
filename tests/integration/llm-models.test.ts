import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { users } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

process.env.APP_SECRET = process.env.APP_SECRET || 'llm-models-test-secret';

import type { ModelMap } from '../../src/lib/server/llm/config';
import type { Provider } from '../../src/lib/server/llm/providers/types';

const { saveAccountLlmConfig } = await import('../../src/lib/server/llm/config');
const { discoverModels, testAccountConnection, probeAccountEndpoint } =
	await import('../../src/lib/server/llm/models');

let pool: pg.Pool;
let db: Database;
let userId: string;

// A provider that answers discovery and a test ping; the transport is never
// touched because both are injected.
const stub: Provider = {
	async *chatStream() {
		yield { type: 'done' };
	},
	async respond() {
		return { content: 'Hello, I can read you.', toolCalls: [] };
	},
	async probe() {
		return { ok: true, supportsStreaming: true, supportsTools: false };
	},
	async listModels() {
		return ['gemma2', 'llama3.1:8b'];
	}
};
const noHttp = async () => {
	throw new Error('the injected provider should not call the transport');
};

async function configure(endpoint: string, models: ModelMap) {
	await saveAccountLlmConfig(db, userId, {
		enabled: false,
		assistantName: '',
		persona: 'balanced',
		endpoint,
		apiKey: endpoint ? 'sk' : '',
		models,
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
	await pool.query('truncate table app_settings, users cascade');
	const [user] = await db
		.insert(users)
		.values({ email: 'w@example.com', displayName: 'Wren', passwordHash: 'x', role: 'user' })
		.returning({ id: users.id });
	userId = user.id;
});

afterAll(async () => {
	await pool.end();
});

describe('discoverModels', () => {
	it('lists the endpoint models, even before the master toggle is on', async () => {
		await configure('https://api.example.com/v1', {});
		const result = await discoverModels(db, userId, { provider: stub, http: noHttp });
		expect(result).toEqual({ ok: true, models: ['gemma2', 'llama3.1:8b'] });
	});

	it('asks for an endpoint when none is configured', async () => {
		await configure('', {});
		const result = await discoverModels(db, userId, { provider: stub, http: noHttp });
		expect(result.ok).toBe(false);
	});

	it('fails gracefully when the endpoint is blocked by the egress guard', async () => {
		await configure('http://127.0.0.1:9/v1', {});
		const result = await discoverModels(db, userId); // real provider + egress
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason.toLowerCase()).toMatch(/block|loopback/);
	});
});

describe('testAccountConnection', () => {
	it("returns the model's reply", async () => {
		await configure('https://api.example.com/v1', { chat: 'llama3.1:8b' });
		const result = await testAccountConnection(db, userId, undefined, {
			provider: stub,
			http: noHttp
		});
		expect(result).toEqual({ ok: true, reply: 'Hello, I can read you.' });
	});

	it('uses an explicitly chosen model over the configured default', async () => {
		await configure('https://api.example.com/v1', { chat: 'default-model' });
		let askedModel = '';
		const capturing: Provider = {
			...stub,
			async respond(req) {
				askedModel = req.model;
				return { content: 'ok', toolCalls: [] };
			}
		};
		await testAccountConnection(db, userId, 'gemma2', { provider: capturing, http: noHttp });
		expect(askedModel).toBe('gemma2');
	});

	it('asks for a model when none is configured or given', async () => {
		await configure('https://api.example.com/v1', {});
		const result = await testAccountConnection(db, userId, undefined, {
			provider: stub,
			http: noHttp
		});
		expect(result.ok).toBe(false);
	});

	it('fails gracefully when the endpoint is blocked by the egress guard', async () => {
		await configure('http://127.0.0.1:9/v1', { chat: 'm' });
		const result = await testAccountConnection(db, userId); // real provider + egress
		expect(result.ok).toBe(false);
	});
});

describe('probeAccountEndpoint', () => {
	it('reports the detected capabilities for the setup screen', async () => {
		await configure('https://api.example.com/v1', { chat: 'm' });
		const toolCapable: Provider = {
			...stub,
			async probe() {
				return { ok: true, supportsStreaming: true, supportsTools: true };
			}
		};
		const result = await probeAccountEndpoint(db, userId, undefined, {
			provider: toolCapable,
			http: noHttp
		});
		expect(result).toEqual({ ok: true, supportsStreaming: true, supportsTools: true });
	});

	it('fails gracefully when the endpoint is blocked by the egress guard', async () => {
		await configure('http://127.0.0.1:9/v1', { chat: 'm' });
		const result = await probeAccountEndpoint(db, userId); // real provider + egress
		expect(result.ok).toBe(false);
	});
});
