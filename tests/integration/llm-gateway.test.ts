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
		async listModels() {
			return [];
		}
	};
	return { provider, count: () => calls, seen };
}

// A provider that records the request and emits canned events, so the gateway's
// resolve -> pick model -> stream path is exercised without a network.
let captured: {
	model: string;
	messages: ChatMessage[];
	tuning?: { thinking?: boolean; effort?: string };
} | null = null;
const stubProvider: Provider = {
	async *chatStream(req) {
		captured = { model: req.model, messages: req.messages, tuning: req.tuning };
		yield { type: 'token', text: `[${req.model}]` };
		yield { type: 'done' };
	},
	async respond(req) {
		captured = { model: req.model, messages: req.messages, tuning: req.tuning };
		return { content: `done:${req.model}`, toolCalls: [] };
	},
	async listModels() {
		return [];
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

	it('passes the saved per-role tuning to the provider, and none when unset', async () => {
		await configure(true);
		await saveAccountLlmConfig(db, userId, {
			enabled: true,
			assistantName: '',
			persona: 'balanced',
			endpoint: 'https://api.example.com/v1',
			apiKey: '',
			models: { chat: 'chat-model', reviewer: 'review-model' },
			tuning: { reviewer: { thinking: true, effort: 'xhigh' } },
			toolCallBudget: 8
		});
		await complete(db, { userId, role: 'reviewer', messages: [] }, stubDeps);
		expect(captured?.tuning).toEqual({ thinking: true, effort: 'xhigh' });
		await complete(db, { userId, role: 'chat', messages: [] }, stubDeps);
		expect(captured?.tuning).toBeUndefined();
	});

	it('keeps the stored tuning when a save omits it, and clears it on {}', async () => {
		await configure(true);
		const base = {
			enabled: true,
			assistantName: '',
			persona: 'balanced' as const,
			endpoint: 'https://api.example.com/v1',
			apiKey: '',
			models: { chat: 'chat-model' },
			toolCallBudget: 8
		};
		await saveAccountLlmConfig(db, userId, {
			...base,
			tuning: { chat: { effort: 'low' } }
		});
		// A save without the field (another form's partial save) keeps it.
		await saveAccountLlmConfig(db, userId, base);
		await complete(db, { userId, role: 'chat', messages: [] }, stubDeps);
		expect(captured?.tuning).toEqual({ effort: 'low' });
		// An explicit empty map clears it.
		await saveAccountLlmConfig(db, userId, { ...base, tuning: {} });
		await complete(db, { userId, role: 'chat', messages: [] }, stubDeps);
		expect(captured?.tuning).toBeUndefined();
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

	it('list_scenes returns the chapter and scene skeleton with ids', async () => {
		await configure(true);
		const { storyId, sceneId } = await seedStoryScene('A quiet opening.');
		const script = scriptedProvider([
			{
				content: '',
				toolCalls: [{ id: 'c1', name: 'list_scenes', arguments: '{}' }]
			},
			{ content: 'One scene so far.' }
		]);
		const text = await complete(
			db,
			{
				userId,
				storyId,
				role: 'chat',
				enableTools: true,
				messages: [{ role: 'user', content: 'what scenes are there?' }]
			},
			{ provider: script.provider, http: noHttp }
		);
		expect(text).toBe('One scene so far.');
		const toolMessage = script.seen[1].find((m) => m.role === 'tool');
		const listed = JSON.parse(toolMessage!.content) as {
			chapters: unknown[];
			unfiledScenes: { id: string; title: string | null }[];
		};
		// The seeded scene has no chapter, so it lists as unfiled, id included.
		expect(listed.unfiledScenes.map((s) => s.id)).toContain(sceneId);
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
				role: 'reviewer',
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

	it('propose_scene_split stages nothing and surfaces a proposal frame on the stream', async () => {
		await configure(true);
		const body = 'The first half ends here.\n\nThe second half starts here.';
		const { storyId, sceneId } = await seedStoryScene(body);
		const script = scriptedProvider([
			{
				content: '',
				toolCalls: [
					{
						id: 'c1',
						name: 'propose_scene_split',
						arguments: JSON.stringify({
							sceneId,
							newSceneStart: 'The second half',
							rationale: 'A clean change of focus.'
						})
					}
				]
			},
			{ content: 'I propose splitting before the second half.' }
		]);
		const events = await drain(
			stream(
				db,
				{
					userId,
					storyId,
					role: 'chat',
					enableTools: true,
					messages: [{ role: 'user', content: 'where should this split?' }]
				},
				{ provider: script.provider, http: noHttp }
			)
		);
		expect(events).toEqual([
			{ type: 'token', text: 'I propose splitting before the second half.' },
			{
				type: 'proposal',
				proposal: {
					sceneId,
					sceneTitle: 'Scene 1',
					before: 'The second half',
					rationale: 'A clean change of focus.'
				}
			},
			{ type: 'done' }
		]);
		// The scene itself is untouched; the proposal lives in the transcript.
		const [scene] = await db
			.select({ bodyMd: scenes.bodyMd })
			.from(scenes)
			.where(eq(scenes.id, sceneId));
		expect(scene.bodyMd).toBe(body);
	});

	it('a bad split point goes back to the model as a retryable tool result', async () => {
		await configure(true);
		const { storyId, sceneId } = await seedStoryScene('Half and half and half again.');
		const script = scriptedProvider([
			{
				content: '',
				toolCalls: [
					{
						id: 'c1',
						name: 'propose_scene_split',
						// The legacy parameter name still lands (cached tool schemas).
						arguments: JSON.stringify({ sceneId, before: 'half', rationale: 'x' })
					}
				]
			},
			{ content: 'I could not pin the spot down.' }
		]);
		const events = await drain(
			stream(
				db,
				{
					userId,
					storyId,
					role: 'chat',
					enableTools: true,
					messages: [{ role: 'user', content: 'split it' }]
				},
				{ provider: script.provider, http: noHttp }
			)
		);
		// No proposal frame; the ambiguity went back as the tool result.
		expect(events.some((e) => e.type === 'proposal')).toBe(false);
		const toolMessage = script.seen[1].find((m) => m.role === 'tool');
		expect(toolMessage?.content).toMatch(/more than once/);
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
			async listModels() {
				return [];
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

	it('refuses a tool call the turn did not offer and stages nothing', async () => {
		await configure(true);
		const { storyId, sceneId } = await seedStoryScene('The cat sat on the mat.');
		// The turn offers only read tools; the model calls suggest_edit anyway
		// (a cached schema, or it ignored the prompt).
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
			{ content: 'understood' }
		]);
		const text = await complete(
			db,
			{
				userId,
				storyId,
				role: 'chat',
				enableTools: true,
				toolNames: ['list_scenes', 'get_scene'],
				messages: [{ role: 'user', content: 'go' }]
			},
			{ provider: script.provider, http: noHttp }
		);
		expect(text).toBe('understood');
		// The refusal went back as a retryable tool result.
		const toolMessage = script.seen[1].find((m) => m.role === 'tool');
		expect(toolMessage?.content).toContain('not available in this turn');
		// Nothing was staged.
		const staged = await db
			.select()
			.from(reviewSuggestions)
			.where(eq(reviewSuggestions.storyId, storyId));
		expect(staged).toHaveLength(0);
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

// The provider discriminator on the saved config picks the adapter; no
// provider is injected here, so the real selection runs and the stub
// transport sees the wire format the adapter speaks.
describe('provider selection', () => {
	function jsonHttp(body: unknown, capture: (url: string, sent: string) => void): HttpRequest {
		return async (url, init) => {
			capture(url, init.body ?? '');
			const text = JSON.stringify(body);
			return {
				status: 200,
				headers: { 'content-type': 'application/json' },
				body: (async function* () {
					yield new TextEncoder().encode(text);
				})(),
				text: async () => text
			};
		};
	}

	it('routes an anthropic config to the Messages API', async () => {
		await saveAccountLlmConfig(db, userId, {
			enabled: true,
			assistantName: '',
			persona: 'balanced',
			provider: 'anthropic',
			endpoint: '',
			apiKey: 'sk-ant-x',
			models: { chat: 'claude-x' },
			toolCallBudget: 8
		});
		let calledUrl = '';
		let sentBody: Record<string, unknown> = {};
		const http = jsonHttp({ content: [{ type: 'text', text: 'hello' }] }, (url, sent) => {
			calledUrl = url;
			sentBody = JSON.parse(sent);
		});
		const text = await complete(
			db,
			{ userId, role: 'chat', messages: [{ role: 'user', content: 'hi' }] },
			{ http }
		);
		expect(text).toBe('hello');
		expect(calledUrl).toBe('https://api.anthropic.com/v1/messages');
		// The persona system message hoists into the top-level system parameter,
		// as a block array carrying the prompt-cache marker.
		const system = sentBody.system as { type: string; text: string }[];
		expect(system).toHaveLength(1);
		expect(system[0].type).toBe('text');
		expect(typeof system[0].text).toBe('string');
		expect(sentBody.messages).toEqual([
			{
				role: 'user',
				content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }]
			}
		]);
	});

	it('routes a custom config to the chat completions API', async () => {
		await configure(true);
		let calledUrl = '';
		const http = jsonHttp({ choices: [{ message: { content: 'hello' } }] }, (url) => {
			calledUrl = url;
		});
		const text = await complete(db, { userId, role: 'chat', messages: [] }, { http });
		expect(text).toBe('hello');
		expect(calledUrl).toBe('https://api.example.com/v1/chat/completions');
	});
});
