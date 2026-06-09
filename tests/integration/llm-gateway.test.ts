import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	reviewSuggestions,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

process.env.APP_SECRET = process.env.APP_SECRET || 'llm-gateway-test-secret';

import type { GatewayDeps } from '../../src/lib/server/llm/gateway';
import type {
	ChatMessage,
	Provider,
	ProviderToolCall,
	HttpRequest,
	StreamEvent
} from '../../src/lib/server/llm/providers/types';

const { saveAccountLlmConfig } = await import('../../src/lib/server/llm/config');
const { listSuggestions, decideSuggestion } = await import('../../src/lib/server/review');
const { complete, stream, AssistantDisabledError } =
	await import('../../src/lib/server/llm/gateway');

let pool: pg.Pool;
let db: Database;
let userId: string;
let universeId: string;

// A provider scripted with a queue of turns, so the agent loop can be driven:
// each call shifts the next { content, toolCalls } off the queue.
function scriptedProvider(turns: { content: string; toolCalls?: ProviderToolCall[] }[]): {
	provider: Provider;
	count: () => number;
	seen: ChatMessage[][];
} {
	let calls = 0;
	const seen: ChatMessage[][] = [];
	const provider: Provider = {
		async *chatStream() {
			yield { type: 'done' };
		},
		async respond(req) {
			calls += 1;
			seen.push(req.messages);
			const turn = turns.shift() ?? { content: '' };
			return { content: turn.content, toolCalls: turn.toolCalls ?? [] };
		},
		async probe() {
			return { ok: true, supportsStreaming: false, supportsTools: true };
		}
	};
	return { provider, count: () => calls, seen };
}

// A provider that records the request and emits canned events, so the gateway's
// resolve -> pick model -> stream path is exercised without a network.
let captured: { model: string; messages: ChatMessage[] } | null = null;
const stubProvider: Provider = {
	async *chatStream(req) {
		captured = { model: req.model, messages: req.messages };
		yield { type: 'token', text: `[${req.model}]` };
		yield { type: 'done' };
	},
	async respond(req) {
		captured = { model: req.model, messages: req.messages };
		return { content: `done:${req.model}`, toolCalls: [] };
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

async function configure(
	enabled: boolean,
	persona: 'balanced' | 'concise' = 'balanced',
	name = ''
) {
	await saveAccountLlmConfig(db, userId, {
		enabled,
		assistantName: name,
		persona,
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
	await pool.query(
		'truncate table review_suggestions, review_comments, review_threads, revisions, scenes, chapters, stories, app_settings, universes, users cascade'
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
	universeId = universe.id;
});

// A story with one scene, owned by the test user, for the tool tests.
async function seedStoryScene(body: string): Promise<{ storyId: string; sceneId: string }> {
	const [story] = await db
		.insert(stories)
		.values({ universeId, ownerId: userId, title: 'S' })
		.returning({ id: stories.id });
	const [scene] = await db
		.insert(scenes)
		.values({ storyId: story.id, globalPosition: 1, title: 'Scene 1', bodyMd: body })
		.returning({ id: scenes.id });
	return { storyId: story.id, sceneId: scene.id };
}

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

	it('prepends a persona system message carrying the name and tone', async () => {
		await configure(true, 'concise', 'Muse');
		await drain(
			stream(db, { userId, role: 'chat', messages: [{ role: 'user', content: 'hi' }] }, stubDeps)
		);
		expect(captured?.messages[0].role).toBe('system');
		expect(captured?.messages[0].content).toContain('Muse');
		expect(captured?.messages[0].content).toContain('concise');
		// The caller's turns follow the persona message.
		expect(captured?.messages[1]).toEqual({ role: 'user', content: 'hi' });
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
			assistantName: '',
			persona: 'balanced',
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

describe('gateway tool loop', () => {
	const noHttp: HttpRequest = async () => {
		throw new Error('the injected provider should not call the transport');
	};

	it('runs a read tool, feeds the result back, and returns the final answer', async () => {
		await configure(true);
		const { storyId, sceneId } = await seedStoryScene('The bell tolled over the harbour.');
		const script = scriptedProvider([
			{
				content: '',
				toolCalls: [{ id: 'c1', name: 'get_scene', arguments: JSON.stringify({ sceneId }) }]
			},
			{ content: 'The scene is about a tolling bell.' }
		]);
		const text = await complete(
			db,
			{
				userId,
				storyId,
				role: 'chat',
				enableTools: true,
				messages: [{ role: 'user', content: 'what happens?' }]
			},
			{ provider: script.provider, http: noHttp }
		);
		expect(text).toBe('The scene is about a tolling bell.');
		expect(script.count()).toBe(2);
		// The second turn saw a tool result carrying the scene body.
		const toolMessage = script.seen[1].find((m) => m.role === 'tool');
		expect(toolMessage?.content).toContain('tolled over the harbour');
	});

	it('a write tool stages a suggestion authored by the Assistant and changes nothing', async () => {
		await configure(true, 'balanced', 'Muse');
		const { storyId, sceneId } = await seedStoryScene('The cat sat on the mat.');
		const script = scriptedProvider([
			{
				content: '',
				toolCalls: [
					{
						id: 'c1',
						name: 'suggest_edit',
						arguments: JSON.stringify({ sceneId, original: 'cat', replacement: 'dog' })
					}
				]
			},
			{ content: 'I suggested a change.' }
		]);
		const text = await complete(
			db,
			{
				userId,
				storyId,
				role: 'editor',
				enableTools: true,
				messages: [{ role: 'user', content: 'edit it' }]
			},
			{ provider: script.provider, http: noHttp }
		);
		expect(text).toBe('I suggested a change.');

		// The scene body is untouched - the edit is only staged.
		const [scene] = await db
			.select({ bodyMd: scenes.bodyMd })
			.from(scenes)
			.where(eq(scenes.id, sceneId));
		expect(scene.bodyMd).toBe('The cat sat on the mat.');

		// A pending, assistant-authored suggestion exists, shown under the name.
		const staged = await db
			.select()
			.from(reviewSuggestions)
			.where(and(eq(reviewSuggestions.storyId, storyId), eq(reviewSuggestions.assistant, true)));
		expect(staged).toHaveLength(1);
		expect(staged[0].status).toBe('pending');

		const suggestions = await listSuggestions(db, storyId);
		expect(suggestions).toHaveLength(1);
		expect(suggestions[0].isAssistant).toBe(true);
		expect(suggestions[0].reviewerName).toBe('Muse');
		expect(suggestions[0].replacement).toBe('dog');

		// The owner accepts it the same way as any reviewer's suggestion.
		const decided = await decideSuggestion(db, userId, staged[0].id, true);
		expect(decided.ok).toBe(true);
		const [after] = await db
			.select({ bodyMd: scenes.bodyMd })
			.from(scenes)
			.where(eq(scenes.id, sceneId));
		expect(after.bodyMd).toBe('The dog sat on the mat.');
	});

	it('caps the loop at the tool-call budget then forces an answer', async () => {
		await saveAccountLlmConfig(db, userId, {
			enabled: true,
			assistantName: '',
			persona: 'balanced',
			endpoint: 'https://api.example.com/v1',
			apiKey: 'sk',
			models: { chat: 'm' },
			toolCallBudget: 2
		});
		const { storyId, sceneId } = await seedStoryScene('Body.');
		// A provider that always asks for another tool; the budget must stop it.
		let calls = 0;
		const alwaysTool: Provider = {
			async *chatStream() {
				yield { type: 'done' };
			},
			async respond(req) {
				calls += 1;
				const hasTools = (req.tools?.length ?? 0) > 0;
				return hasTools
					? {
							content: '',
							toolCalls: [
								{ id: `c${calls}`, name: 'get_scene', arguments: JSON.stringify({ sceneId }) }
							]
						}
					: { content: 'forced answer', toolCalls: [] };
			},
			async probe() {
				return { ok: true, supportsStreaming: false, supportsTools: true };
			}
		};
		const text = await complete(
			db,
			{
				userId,
				storyId,
				role: 'chat',
				enableTools: true,
				messages: [{ role: 'user', content: 'go' }]
			},
			{ provider: alwaysTool, http: noHttp }
		);
		expect(text).toBe('forced answer');
		// Two tool rounds (budget) plus the final tools-withdrawn answer.
		expect(calls).toBe(3);
	});

	it('does not offer tools without a story context', async () => {
		await configure(true);
		const script = scriptedProvider([{ content: 'plain answer' }]);
		const text = await complete(
			db,
			{ userId, role: 'chat', enableTools: true, messages: [{ role: 'user', content: 'hi' }] },
			{ provider: script.provider, http: noHttp }
		);
		expect(text).toBe('plain answer');
		// No story -> tools never offered.
		expect(script.seen[0].some((m) => m.role === 'tool')).toBe(false);
	});
});
