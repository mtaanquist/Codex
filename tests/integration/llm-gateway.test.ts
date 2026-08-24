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

const { saveAccountLlmConfig, saveModelContext } = await import('../../src/lib/server/llm/config');
const { listSuggestions, decideSuggestion } = await import('../../src/lib/server/review');
const { complete, completeDetailed, stream, AssistantDisabledError } =
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
	offered: string[][];
} {
	let calls = 0;
	const seen: ChatMessage[][] = [];
	const offered: string[][] = [];
	const provider: Provider = {
		async *chatStream() {
			yield { type: 'done' };
		},
		async respond(req) {
			calls += 1;
			seen.push(req.messages);
			offered.push((req.tools ?? []).map((tool) => tool.name));
			const turn = turns.shift() ?? { content: '' };
			return { content: turn.content, toolCalls: turn.toolCalls ?? [] };
		},
		async listModels() {
			return [];
		}
	};
	return { provider, count: () => calls, seen, offered };
}

// A provider that records the request and emits canned events, so the gateway's
// resolve -> pick model -> stream path is exercised without a network.
let captured: {
	model: string;
	messages: ChatMessage[];
	maxTokens?: number;
	tuning?: { thinking?: boolean; effort?: string };
	extraParams?: Record<string, unknown>;
	webSearch?: boolean;
} | null = null;
const stubProvider: Provider = {
	async *chatStream(req) {
		captured = {
			model: req.model,
			messages: req.messages,
			maxTokens: req.maxTokens,
			tuning: req.tuning,
			extraParams: req.extraParams,
			webSearch: req.webSearch
		};
		yield { type: 'token', text: `[${req.model}]` };
		yield { type: 'done' };
	},
	async respond(req) {
		captured = {
			model: req.model,
			messages: req.messages,
			maxTokens: req.maxTokens,
			tuning: req.tuning,
			extraParams: req.extraParams,
			webSearch: req.webSearch
		};
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

	it('sends the extra parameters for the role, account ones under its own', async () => {
		await configure(true);
		await saveAccountLlmConfig(db, userId, {
			enabled: true,
			assistantName: '',
			persona: 'balanced',
			endpoint: 'https://api.example.com/v1',
			apiKey: '',
			models: { chat: 'chat-model' },
			extraParams: { top_p: 0.9 },
			tuning: { reviewer: { extraParams: { top_p: 0.4, min_p: 0.05 } } },
			toolCallBudget: 8
		});
		await complete(db, { userId, role: 'chat', messages: [] }, stubDeps);
		expect(captured?.extraParams).toEqual({ top_p: 0.9 });
		await complete(db, { userId, role: 'reviewer', messages: [] }, stubDeps);
		expect(captured?.extraParams).toEqual({ top_p: 0.4, min_p: 0.05 });
	});

	it('offers the provider web search only on an established universe, when opted in', async () => {
		const anthropic = {
			enabled: true,
			assistantName: '',
			persona: 'balanced' as const,
			provider: 'anthropic' as const,
			endpoint: 'https://api.anthropic.com',
			apiKey: 'sk-ant',
			models: { chat: 'claude-opus-5' },
			toolCallBudget: 8
		};
		const [ordinary] = await db
			.insert(universes)
			.values({ ownerId: userId, name: 'Mine' })
			.returning({ id: universes.id });
		const [established] = await db
			.insert(universes)
			.values({ ownerId: userId, name: 'Faerun', establishedSetting: true })
			.returning({ id: universes.id });

		// Opted in: the established universe gets it, the writer's own does not.
		await saveAccountLlmConfig(db, userId, { ...anthropic, webSearch: true });
		await complete(
			db,
			{ userId, universeId: established.id, role: 'chat', messages: [] },
			stubDeps
		);
		expect(captured?.webSearch).toBe(true);
		await complete(db, { userId, universeId: ordinary.id, role: 'chat', messages: [] }, stubDeps);
		expect(captured?.webSearch).toBe(false);
		// No universe at all means nothing to check canon against.
		await complete(db, { userId, role: 'chat', messages: [] }, stubDeps);
		expect(captured?.webSearch).toBe(false);

		// Opted out: never, not even there.
		await saveAccountLlmConfig(db, userId, { ...anthropic, webSearch: false });
		await complete(
			db,
			{ userId, universeId: established.id, role: 'chat', messages: [] },
			stubDeps
		);
		expect(captured?.webSearch).toBe(false);
	});

	it('never offers web search on an OpenAI-compatible endpoint', async () => {
		const [established] = await db
			.insert(universes)
			.values({ ownerId: userId, name: 'Faerun', establishedSetting: true })
			.returning({ id: universes.id });
		await saveAccountLlmConfig(db, userId, {
			enabled: true,
			assistantName: '',
			persona: 'balanced',
			endpoint: 'https://api.example.com/v1',
			apiKey: 'sk',
			models: { chat: 'chat-model' },
			webSearch: true,
			toolCallBudget: 8
		});
		await complete(
			db,
			{ userId, universeId: established.id, role: 'chat', messages: [] },
			stubDeps
		);
		expect(captured?.webSearch).toBe(false);
	});

	it('sends no extra parameters when none are configured', async () => {
		await configure(true);
		await complete(db, { userId, role: 'chat', messages: [] }, stubDeps);
		expect(captured?.extraParams).toBeUndefined();
	});

	it("lets a role's reply length override what the surface asked for", async () => {
		await configure(true);
		await saveAccountLlmConfig(db, userId, {
			enabled: true,
			assistantName: '',
			persona: 'balanced',
			endpoint: 'https://api.example.com/v1',
			apiKey: '',
			models: { chat: 'chat-model' },
			tuning: { chat: { maxTokens: 300 } },
			toolCallBudget: 8
		});
		await complete(db, { userId, role: 'chat', maxTokens: 2048, messages: [] }, stubDeps);
		expect(captured?.maxTokens).toBe(300);
		// A role with none set keeps the surface's figure, and its default
		// otherwise.
		await complete(db, { userId, role: 'reviewer', maxTokens: 900, messages: [] }, stubDeps);
		expect(captured?.maxTokens).toBe(900);
		await complete(db, { userId, role: 'reviewer', messages: [] }, stubDeps);
		expect(captured?.maxTokens).toBe(4096);
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

	it('get_scene returns a long scene in full, truncating only pathological bodies', async () => {
		await configure(true);
		// ~8K words / ~48K characters: a long but realistic novel scene, which a
		// review must see whole. Word 7999 sits near the end.
		const longBody = Array.from({ length: 8000 }, (_, i) => `word${i}`).join(' ');
		const { storyId, sceneId } = await seedStoryScene(longBody);
		const script = scriptedProvider([
			{
				content: '',
				toolCalls: [{ id: 'c1', name: 'get_scene', arguments: JSON.stringify({ sceneId }) }]
			},
			{ content: 'read it all' }
		]);
		await complete(
			db,
			{
				userId,
				storyId,
				role: 'chat',
				enableTools: true,
				messages: [{ role: 'user', content: 'review this' }]
			},
			{ provider: script.provider, http: noHttp }
		);
		const toolMessage = script.seen[1].find((m) => m.role === 'tool');
		expect(toolMessage?.content).toContain('word7999');
		expect(toolMessage?.content).not.toContain('truncated');

		// Past the cap, the result says exactly how much was cut.
		const huge = 'x'.repeat(250_000);
		const seeded = await seedStoryScene(huge);
		const script2 = scriptedProvider([
			{
				content: '',
				toolCalls: [
					{ id: 'c1', name: 'get_scene', arguments: JSON.stringify({ sceneId: seeded.sceneId }) }
				]
			},
			{ content: 'ok' }
		]);
		await complete(
			db,
			{
				userId,
				storyId: seeded.storyId,
				role: 'chat',
				enableTools: true,
				messages: [{ role: 'user', content: 'review this' }]
			},
			{ provider: script2.provider, http: noHttp }
		);
		const toolMessage2 = script2.seen[1].find((m) => m.role === 'tool');
		expect(toolMessage2?.content).toContain('truncated: showing the first 200000 of 250000');
	});

	it('a known context window caps get_scene at about a quarter of it', async () => {
		await configure(true);
		// A 4K-token window: a quarter of it is about 4000 characters, under the
		// 8000 character floor, so the floor applies.
		await saveModelContext(db, userId, { 'chat-model': 4096 });
		const body = 'x'.repeat(20_000);
		const { storyId, sceneId } = await seedStoryScene(body);
		const script = scriptedProvider([
			{
				content: '',
				toolCalls: [{ id: 'c1', name: 'get_scene', arguments: JSON.stringify({ sceneId }) }]
			},
			{ content: 'ok' }
		]);
		await complete(
			db,
			{
				userId,
				storyId,
				role: 'chat',
				enableTools: true,
				messages: [{ role: 'user', content: 'read it' }]
			},
			{ provider: script.provider, http: noHttp }
		);
		expect(script.seen[1].find((m) => m.role === 'tool')?.content).toContain(
			'truncated: showing the first 8000 of 20000'
		);

		// A 32K window leaves room for 32000 characters, so the same scene is whole.
		await saveModelContext(db, userId, { 'chat-model': 32768 });
		const script2 = scriptedProvider([
			{
				content: '',
				toolCalls: [{ id: 'c1', name: 'get_scene', arguments: JSON.stringify({ sceneId }) }]
			},
			{ content: 'ok' }
		]);
		await complete(
			db,
			{
				userId,
				storyId,
				role: 'chat',
				enableTools: true,
				messages: [{ role: 'user', content: 'read it' }]
			},
			{ provider: script2.provider, http: noHttp }
		);
		expect(script2.seen[1].find((m) => m.role === 'tool')?.content).not.toContain('truncated');
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
			stories: {
				storyId: string;
				chapters: unknown[];
				unfiledScenes: { id: string; title: string | null }[];
			}[];
		};
		// The skeleton is grouped by story across the universe; the seeded scene
		// has no chapter, so it lists as unfiled under its story, id included.
		const allUnfiled = listed.stories.flatMap((s) => s.unfiledScenes.map((sc) => sc.id));
		expect(allUnfiled).toContain(sceneId);
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

	it('suggest_edit tolerates reshaped quotes and refuses a repeat of itself', async () => {
		await configure(true);
		const body = 'She said "run", and the dog\'s ears  went flat.';
		const { storyId, sceneId } = await seedStoryScene(body);
		// The quote comes back with curly quotes and a collapsed whitespace run,
		// as a small local model tends to echo it.
		const original = `She said \u201crun\u201d, and the dog\u2019s ears went flat.`;
		const call = {
			id: 'c1',
			name: 'suggest_edit',
			arguments: JSON.stringify({ sceneId, original, replacement: 'She said nothing.' })
		};
		const script = scriptedProvider([
			{ content: '', toolCalls: [call] },
			{ content: '', toolCalls: [{ ...call, id: 'c2' }] },
			{ content: 'Staged.' }
		]);
		await complete(
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

		const staged = await db
			.select()
			.from(reviewSuggestions)
			.where(and(eq(reviewSuggestions.storyId, storyId), eq(reviewSuggestions.assistant, true)));
		expect(staged).toHaveLength(1);
		// The staged range indexes the real body, curly quotes and all.
		expect(body.slice(staged[0].rangeStart, staged[0].rangeEnd)).toBe(body);
		// The repeat came back as a tool result saying it was already staged.
		const repeatResult = script.seen[2].filter((m) => m.role === 'tool').at(-1);
		expect(repeatResult?.content).toContain('already staged');
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
		const choices: (string | undefined)[] = [];
		const toolCounts: number[] = [];
		const alwaysTool: Provider = {
			async *chatStream() {
				yield { type: 'done' };
			},
			async respond(req) {
				calls += 1;
				choices.push(req.toolChoice);
				toolCounts.push(req.tools?.length ?? 0);
				return req.toolChoice === 'none'
					? { content: 'forced answer', toolCalls: [] }
					: {
							content: '',
							toolCalls: [
								{ id: `c${calls}`, name: 'get_scene', arguments: JSON.stringify({ sceneId }) }
							]
						};
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
		// Two tool rounds (budget) plus the concluding answer.
		expect(calls).toBe(3);
		// The tools are declared on every round, the history depends on them; only
		// the choice changes on the last one.
		expect(toolCounts.every((count) => count > 0)).toBe(true);
		expect(choices).toEqual([undefined, undefined, 'none']);
	});

	it('never drops the tools mid-conversation, and dispatches nothing on the concluding round', async () => {
		await saveAccountLlmConfig(db, userId, {
			enabled: true,
			assistantName: '',
			persona: 'balanced',
			endpoint: 'https://api.example.com/v1',
			apiKey: 'sk',
			models: { chat: 'm' },
			toolCallBudget: 1
		});
		const { storyId, sceneId } = await seedStoryScene('The cat sat on the mat.');
		let calls = 0;
		const requests: { tools: number; choice?: string }[] = [];
		// A non-compliant endpoint: it emits a write tool call even under
		// tool_choice none. Nothing may be staged from it.
		const defiant: Provider = {
			async *chatStream() {
				yield { type: 'done' };
			},
			async respond(req) {
				calls += 1;
				requests.push({ tools: req.tools?.length ?? 0, choice: req.toolChoice });
				return {
					content: calls === 1 ? '' : 'concluded',
					toolCalls: [
						{
							id: `c${calls}`,
							name: 'suggest_edit',
							arguments: JSON.stringify({ sceneId, original: 'cat', replacement: 'dog' })
						}
					]
				};
			},
			async listModels() {
				return [];
			}
		};
		const result = await completeDetailed(
			db,
			{
				userId,
				storyId,
				role: 'chat',
				enableTools: true,
				messages: [{ role: 'user', content: 'go' }]
			},
			{ provider: defiant, http: noHttp }
		);

		expect(calls).toBe(2);
		expect(result.content).toBe('concluded');
		expect(result.stopped).toBe('budget');
		expect(requests[0]).toMatchObject({ choice: undefined });
		expect(requests[1]).toMatchObject({ choice: 'none' });
		expect(requests[0].tools).toBeGreaterThan(0);
		expect(requests[1].tools).toBe(requests[0].tools);
		// One edit staged by the budgeted round; the concluding round's call was
		// ignored rather than dispatched.
		const staged = await db
			.select({ id: reviewSuggestions.id })
			.from(reviewSuggestions)
			.where(eq(reviewSuggestions.sceneId, sceneId));
		expect(staged).toHaveLength(1);
	});

	it('the minimal tool profile offers three tools and halves the budget', async () => {
		await saveAccountLlmConfig(db, userId, {
			enabled: true,
			assistantName: '',
			persona: 'balanced',
			endpoint: 'https://api.example.com/v1',
			apiKey: 'sk',
			models: { chat: 'm' },
			toolCallBudget: 8,
			toolProfile: 'minimal'
		});
		const { storyId, sceneId } = await seedStoryScene('Body.');
		let calls = 0;
		const seenTools: string[][] = [];
		const alwaysTool: Provider = {
			async *chatStream() {
				yield { type: 'done' };
			},
			async respond(req) {
				calls += 1;
				seenTools.push((req.tools ?? []).map((tool) => tool.name));
				return req.toolChoice === 'none'
					? { content: 'forced answer', toolCalls: [] }
					: {
							content: '',
							toolCalls: [
								{ id: `c${calls}`, name: 'get_scene', arguments: JSON.stringify({ sceneId }) }
							]
						};
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
		expect(seenTools[0]).toEqual(['get_scene', 'suggest_edit', 'leave_comment']);
		expect(text).toBe('forced answer');
		// Budget 8 halved to 4: four tool rounds plus the concluding answer.
		expect(calls).toBe(5);
	});

	it('a surface naming its own tools is unaffected by the minimal profile', async () => {
		await saveAccountLlmConfig(db, userId, {
			enabled: true,
			assistantName: '',
			persona: 'balanced',
			endpoint: 'https://api.example.com/v1',
			apiKey: 'sk',
			models: { chat: 'm' },
			toolCallBudget: 8,
			toolProfile: 'minimal'
		});
		const { storyId } = await seedStoryScene('Body.');
		const script = scriptedProvider([{ content: 'ok' }]);
		await complete(
			db,
			{
				userId,
				storyId,
				role: 'chat',
				enableTools: true,
				toolNames: ['reply_in_thread', 'update_suggestion'],
				messages: [{ role: 'user', content: 'go' }]
			},
			{ provider: script.provider, http: noHttp }
		);
		expect(script.offered[0]).toEqual(['reply_in_thread', 'update_suggestion']);
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

	it('never dispatches tool calls from a truncated round, and retries with more room', async () => {
		await configure(true);
		const { storyId, sceneId } = await seedStoryScene('The cat sat on the mat.');
		// The first round hits the token cap mid-arguments; the retry has room and
		// asks for a read instead, so nothing is ever staged from the cut-off edit.
		const maxTokens: number[] = [];
		let round = 0;
		const truncating: Provider = {
			async *chatStream() {
				yield { type: 'done' };
			},
			async respond(req) {
				maxTokens.push(req.maxTokens);
				round += 1;
				if (round === 1) {
					return {
						content: '',
						finishReason: 'length',
						toolCalls: [
							{
								id: 'c1',
								name: 'suggest_edit',
								// Truncated JSON that still parses into a plausible edit.
								arguments: JSON.stringify({ sceneId, original: 'cat sat', replacement: 'dog' })
							}
						]
					};
				}
				if (round === 2) {
					return {
						content: '',
						finishReason: 'toolCalls',
						toolCalls: [{ id: 'c2', name: 'get_scene', arguments: JSON.stringify({ sceneId }) }]
					};
				}
				return { content: 'I read it first.', toolCalls: [], finishReason: 'stop' };
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
				role: 'reviewer',
				enableTools: true,
				messages: [{ role: 'user', content: 'go' }]
			},
			{ provider: truncating, http: noHttp }
		);
		expect(text).toBe('I read it first.');
		// The retry doubled the room.
		expect(maxTokens[1]).toBe(maxTokens[0] * 2);
		// The truncated suggest_edit never ran.
		const staged = await db
			.select()
			.from(reviewSuggestions)
			.where(eq(reviewSuggestions.storyId, storyId));
		expect(staged).toHaveLength(0);
	});

	it('caps the truncation retry at the room left in a known window', async () => {
		await configure(true);
		// A small window: doubling the reviewer's 4096-token round would ask for
		// more output than the window has left once the prompt is in it.
		await saveModelContext(db, userId, { 'chat-model': 8192 });
		const { storyId } = await seedStoryScene('The cat sat on the mat.');
		const maxTokens: number[] = [];
		const truncating: Provider = {
			async *chatStream() {
				yield { type: 'done' };
			},
			async respond(req) {
				maxTokens.push(req.maxTokens);
				return maxTokens.length === 1
					? { content: '', finishReason: 'length' as const, toolCalls: [] }
					: { content: 'shorter this time', toolCalls: [], finishReason: 'stop' as const };
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
				role: 'reviewer',
				enableTools: true,
				maxTokens: 4096,
				messages: [{ role: 'user', content: 'go' }]
			},
			{ provider: truncating, http: noHttp }
		);
		expect(text).toBe('shorter this time');
		expect(maxTokens[0]).toBe(4096);
		// Doubling would be 8192, more than the 85 percent usable window; the
		// retry asks for what is actually left instead.
		expect(maxTokens[1]).toBeGreaterThanOrEqual(4096);
		expect(maxTokens[1]).toBeLessThan(8192);
	});

	it('fails the round when the retry is truncated too', async () => {
		await configure(true);
		const { storyId, sceneId } = await seedStoryScene('The cat sat on the mat.');
		const alwaysTruncated: Provider = {
			async *chatStream() {
				yield { type: 'done' };
			},
			async respond() {
				return {
					content: '',
					finishReason: 'length' as const,
					toolCalls: [
						{
							id: 'c1',
							name: 'suggest_edit',
							arguments: JSON.stringify({ sceneId, original: 'cat', replacement: 'dog' })
						}
					]
				};
			},
			async listModels() {
				return [];
			}
		};
		await expect(
			complete(
				db,
				{
					userId,
					storyId,
					role: 'reviewer',
					enableTools: true,
					messages: [{ role: 'user', content: 'go' }]
				},
				{ provider: alwaysTruncated, http: noHttp }
			)
		).rejects.toThrow(/cut off/);
		const staged = await db
			.select()
			.from(reviewSuggestions)
			.where(eq(reviewSuggestions.storyId, storyId));
		expect(staged).toHaveLength(0);
	});

	it('does not offer tools without a story or universe context', async () => {
		await configure(true);
		const script = scriptedProvider([{ content: 'plain answer' }]);
		const text = await complete(
			db,
			{ userId, role: 'chat', enableTools: true, messages: [{ role: 'user', content: 'hi' }] },
			{ provider: script.provider, http: noHttp }
		);
		expect(text).toBe('plain answer');
		// No story and no universe -> tools never offered.
		expect(script.seen[0].some((m) => m.role === 'tool')).toBe(false);
	});
});

// The read tools reach every story in the universe, which is the cross-story
// continuity payoff. A scene in another story of the same universe is readable
// from a story focus or from the universe surface; one in another universe or
// another user's work is not.
describe('gateway universe-scoped tools', () => {
	const noHttp: HttpRequest = async () => {
		throw new Error('the injected provider should not call the transport');
	};

	async function seedSceneIn(universe: string, body: string): Promise<string> {
		const [story] = await db
			.insert(stories)
			.values({ universeId: universe, ownerId: userId, title: 'S' })
			.returning({ id: stories.id });
		const [scene] = await db
			.insert(scenes)
			.values({ storyId: story.id, globalPosition: 1, title: 'Scene', bodyMd: body })
			.returning({ id: scenes.id });
		return scene.id;
	}

	async function readSceneVia(
		req: { storyId?: string; universeId?: string },
		sceneId: string
	): Promise<string> {
		const script = scriptedProvider([
			{
				content: '',
				toolCalls: [{ id: 'c1', name: 'get_scene', arguments: JSON.stringify({ sceneId }) }]
			},
			{ content: 'read' }
		]);
		await complete(
			db,
			{
				userId,
				...req,
				role: 'chat',
				enableTools: true,
				messages: [{ role: 'user', content: 'go' }]
			},
			{ provider: script.provider, http: noHttp }
		);
		return script.seen[1].find((m) => m.role === 'tool')!.content;
	}

	it('reads another story in the same universe from a story focus and from the universe surface', async () => {
		await configure(true);
		const { storyId: storyA } = await seedStoryScene('Story A opening.');
		const sceneB = await seedSceneIn(universeId, 'Story B holds the secret.');

		// From story A's focus: the other story in the universe is reachable.
		expect(await readSceneVia({ storyId: storyA }, sceneB)).toContain('Story B holds the secret.');
		// From the universe surface (no story focus): also reachable.
		expect(await readSceneVia({ universeId }, sceneB)).toContain('Story B holds the secret.');
	});

	it('refuses a scene in another universe or another user, even with a valid id', async () => {
		await configure(true);
		const [otherUniverse] = await db
			.insert(universes)
			.values({ ownerId: userId, name: 'Other' })
			.returning({ id: universes.id });
		const sceneElsewhere = await seedSceneIn(otherUniverse.id, 'A different world.');
		// The universe surface is scoped to universeId; a scene in another universe
		// is not found.
		expect(await readSceneVia({ universeId }, sceneElsewhere)).toContain('No scene with that id');

		const [stranger] = await db
			.insert(users)
			.values({ email: 's@example.com', displayName: 'Sam', passwordHash: 'x', role: 'user' })
			.returning({ id: users.id });
		const [strangerUniverse] = await db
			.insert(universes)
			.values({ ownerId: stranger.id, name: 'Strangers' })
			.returning({ id: universes.id });
		const [strangerStory] = await db
			.insert(stories)
			.values({ universeId: strangerUniverse.id, ownerId: stranger.id, title: 'X' })
			.returning({ id: stories.id });
		const [strangerScene] = await db
			.insert(scenes)
			.values({ storyId: strangerStory.id, globalPosition: 1, bodyMd: 'Secret.' })
			.returning({ id: scenes.id });
		expect(await readSceneVia({ universeId }, strangerScene.id)).toContain('No scene with that id');
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

// A long run appends every tool result to the conversation, so a small window
// fills up mid-loop. The guard withdraws the tools before the next request
// would overflow the endpoint.
describe('gateway context guard', () => {
	const noHttp: HttpRequest = async () => {
		throw new Error('the injected provider should not call the transport');
	};

	// A provider that keeps asking for the same scene for as long as tools are
	// offered, and answers plainly once they are gone.
	function greedyReader(sceneId: string): {
		provider: Provider;
		offered: string[][];
		choices: (string | undefined)[];
		seen: ChatMessage[][];
	} {
		const offered: string[][] = [];
		const choices: (string | undefined)[] = [];
		const seen: ChatMessage[][] = [];
		let calls = 0;
		const provider: Provider = {
			async *chatStream() {
				yield { type: 'done' };
			},
			async respond(req) {
				calls += 1;
				offered.push((req.tools ?? []).map((tool) => tool.name));
				choices.push(req.toolChoice);
				seen.push(req.messages.map((m) => ({ ...m })));
				return req.toolChoice === 'none'
					? { content: 'wrapping up', toolCalls: [] }
					: {
							content: '',
							toolCalls: [
								{ id: `c${calls}`, name: 'get_scene', arguments: JSON.stringify({ sceneId }) }
							]
						};
			},
			async listModels() {
				return [];
			}
		};
		return { provider, offered, choices, seen };
	}

	it('withdraws tools and nudges the model when the conversation nears the window', async () => {
		await configure(true);
		// A 4K window: one full scene read (capped at 8000 characters, about 2000
		// tokens) plus the next round's output allowance crosses the margin.
		await saveModelContext(db, userId, { 'chat-model': 4096 });
		const { storyId, sceneId } = await seedStoryScene('x'.repeat(40_000));
		const script = greedyReader(sceneId);
		const result = await completeDetailed(
			db,
			{
				userId,
				storyId,
				role: 'chat',
				enableTools: true,
				messages: [{ role: 'user', content: 'read everything' }]
			},
			{ provider: script.provider, http: noHttp }
		);
		expect(result.content).toBe('wrapping up');
		expect(result.stopped).toBe('context');
		// Both rounds declare the tools (the history holds tool turns that need
		// them); the second forbids calling them and carries the nudge.
		expect(script.offered).toHaveLength(2);
		expect(script.offered[0].length).toBeGreaterThan(0);
		expect(script.offered[1]).toEqual(script.offered[0]);
		expect(script.choices).toEqual([undefined, 'none']);
		expect(script.seen[1].at(-1)?.content).toMatch(/context window is nearly full/i);
	});

	it('counts a tool call arguments towards the window, not just its text', async () => {
		await configure(true);
		await saveModelContext(db, userId, { 'chat-model': 8192 });
		const { storyId, sceneId } = await seedStoryScene('The cat sat on the mat.');
		// Every round stages a long passage. The assistant turns carry almost no
		// content; the weight is entirely in the tool-call arguments, which go back
		// on the wire every round.
		const passage = 'x'.repeat(6000);
		let calls = 0;
		const choices: (string | undefined)[] = [];
		const stager: Provider = {
			async *chatStream() {
				yield { type: 'done' };
			},
			async respond(req) {
				calls += 1;
				choices.push(req.toolChoice);
				return req.toolChoice === 'none'
					? { content: 'out of room', toolCalls: [] }
					: {
							content: '',
							toolCalls: [
								{
									id: `c${calls}`,
									name: 'leave_comment',
									arguments: JSON.stringify({ sceneId, quote: 'cat', comment: passage })
								}
							]
						};
			},
			async listModels() {
				return [];
			}
		};
		const result = await completeDetailed(
			db,
			{
				userId,
				storyId,
				role: 'chat',
				enableTools: true,
				messages: [{ role: 'user', content: 'annotate' }]
			},
			{ provider: stager, http: noHttp }
		);

		expect(result.stopped).toBe('context');
		expect(result.content).toBe('out of room');
		// Two staged comments at 1500 tokens of arguments each fill the usable
		// window; without counting them the loop would have run the full budget.
		expect(calls).toBeLessThan(8);
		expect(choices.at(-1)).toBe('none');
	});

	it('does not guard when the window is unknown, and reports a budget stop', async () => {
		await saveAccountLlmConfig(db, userId, {
			enabled: true,
			assistantName: '',
			persona: 'balanced',
			endpoint: 'https://api.example.com/v1',
			apiKey: 'sk',
			models: { chat: 'chat-model' },
			toolCallBudget: 3
		});
		// No stored context for the model, so nothing bounds the conversation but
		// the tool-call budget.
		const { storyId, sceneId } = await seedStoryScene('x'.repeat(40_000));
		const script = greedyReader(sceneId);
		const result = await completeDetailed(
			db,
			{
				userId,
				storyId,
				role: 'chat',
				enableTools: true,
				messages: [{ role: 'user', content: 'read everything' }]
			},
			{ provider: script.provider, http: noHttp }
		);
		expect(result.content).toBe('wrapping up');
		expect(result.stopped).toBe('budget');
		// Three tool rounds (the budget) plus the concluding answer, with no
		// context nudge among them.
		expect(script.offered).toHaveLength(4);
		expect(script.offered[2].length).toBeGreaterThan(0);
		expect(script.offered[3]).toEqual(script.offered[0]);
		expect(script.choices).toEqual([undefined, undefined, undefined, 'none']);
		expect(script.seen[3].some((m) => m.content.includes('context window is nearly full'))).toBe(
			false
		);
	});

	it('leaves a run that finishes on its own unmarked', async () => {
		await configure(true);
		await saveModelContext(db, userId, { 'chat-model': 128_000 });
		const { storyId } = await seedStoryScene('A short scene.');
		const script = scriptedProvider([{ content: 'done reading' }]);
		const result = await completeDetailed(
			db,
			{
				userId,
				storyId,
				role: 'chat',
				enableTools: true,
				messages: [{ role: 'user', content: 'hi' }]
			},
			{ provider: script.provider, http: noHttp }
		);
		expect(result).toMatchObject({ content: 'done reading' });
		expect(result.stopped).toBeUndefined();
	});
});

// A local endpoint reloading a model answers one request with a 500 and the
// next one fine; the round should not die on the blip.
describe('gateway request retries', () => {
	const noHttp: HttpRequest = async () => {
		throw new Error('the injected provider should not call the transport');
	};
	// Injected so the backoff does not slow the suite down.
	const noSleep = async () => {};

	// Fails the first attempt with the given error, then answers.
	function flakyProvider(
		err: Error,
		content: string
	): { provider: Provider; attempts: () => number } {
		let attempts = 0;
		const provider: Provider = {
			async *chatStream() {
				yield { type: 'done' };
			},
			async respond() {
				attempts += 1;
				if (attempts === 1) throw err;
				return { content, toolCalls: [] };
			},
			async listModels() {
				return [];
			}
		};
		return { provider, attempts: () => attempts };
	}

	it('retries a 5xx on the plain completion path', async () => {
		await configure(true);
		const flaky = flakyProvider(
			new Error('Endpoint returned 503: model loading'),
			'second time lucky'
		);
		const text = await complete(
			db,
			{ userId, role: 'chat', messages: [{ role: 'user', content: 'hi' }] },
			{ provider: flaky.provider, http: noHttp, sleep: noSleep }
		);
		expect(text).toBe('second time lucky');
		expect(flaky.attempts()).toBe(2);
	});

	it('retries a 429', async () => {
		await configure(true);
		const flaky = flakyProvider(new Error('Endpoint returned 429: slow down'), 'after the wait');
		const text = await complete(
			db,
			{ userId, role: 'chat', messages: [] },
			{ provider: flaky.provider, http: noHttp, sleep: noSleep }
		);
		expect(text).toBe('after the wait');
		expect(flaky.attempts()).toBe(2);
	});

	it("dispatches a retried round's tools exactly once", async () => {
		await configure(true);
		const { storyId, sceneId } = await seedStoryScene('The cat sat on the mat.');
		// The request that carries the edit fails once at the transport, then
		// succeeds. The retry re-sends the request only, so the staged edit lands
		// a single time.
		let attempts = 0;
		let answered = 0;
		const provider: Provider = {
			async *chatStream() {
				yield { type: 'done' };
			},
			async respond() {
				attempts += 1;
				if (attempts === 1) throw new Error('fetch failed');
				answered += 1;
				return answered === 1
					? {
							content: '',
							toolCalls: [
								{
									id: 'c1',
									name: 'suggest_edit',
									arguments: JSON.stringify({ sceneId, original: 'cat', replacement: 'dog' })
								}
							]
						}
					: { content: 'staged it', toolCalls: [] };
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
				role: 'reviewer',
				enableTools: true,
				messages: [{ role: 'user', content: 'edit it' }]
			},
			{ provider, http: noHttp, sleep: noSleep }
		);
		expect(text).toBe('staged it');
		expect(attempts).toBe(3);
		const staged = await db
			.select()
			.from(reviewSuggestions)
			.where(eq(reviewSuggestions.storyId, storyId));
		expect(staged).toHaveLength(1);
	});

	it('gives up after two retries and surfaces the failure', async () => {
		await configure(true);
		let attempts = 0;
		const alwaysDown: Provider = {
			async *chatStream() {
				yield { type: 'done' };
			},
			async respond() {
				attempts += 1;
				throw new Error('Endpoint returned 500: upstream error');
			},
			async listModels() {
				return [];
			}
		};
		await expect(
			complete(
				db,
				{ userId, role: 'chat', messages: [] },
				{ provider: alwaysDown, http: noHttp, sleep: noSleep }
			)
		).rejects.toThrow(/500/);
		expect(attempts).toBe(3);
	});

	it('never retries a bad request, an abort, or an aborted signal', async () => {
		await configure(true);
		async function attemptsFor(err: Error, signal?: AbortSignal): Promise<number> {
			let attempts = 0;
			const provider: Provider = {
				async *chatStream() {
					yield { type: 'done' };
				},
				async respond() {
					attempts += 1;
					throw err;
				},
				async listModels() {
					return [];
				}
			};
			await expect(
				complete(
					db,
					{ userId, role: 'chat', messages: [], signal },
					{ provider, http: noHttp, sleep: noSleep }
				)
			).rejects.toThrow();
			return attempts;
		}
		expect(await attemptsFor(new Error('Endpoint returned 400: bad request'))).toBe(1);
		expect(await attemptsFor(new Error('Endpoint returned 401: no key'))).toBe(1);
		const aborted = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
		expect(await attemptsFor(aborted)).toBe(1);
		// A 200 with a body that is not JSON: the adapter's JSON.parse throws a
		// SyntaxError. The endpoint will produce the same broken body on a retry,
		// and it bills for every attempt.
		let syntaxError: Error = new Error('unreachable');
		try {
			JSON.parse('<html>gateway timeout</html>');
		} catch (err) {
			syntaxError = err as Error;
		}
		expect(syntaxError).toBeInstanceOf(SyntaxError);
		expect(await attemptsFor(syntaxError)).toBe(1);
		// A transport error that would normally be retried, but the caller has
		// walked away.
		const controller = new AbortController();
		controller.abort();
		expect(await attemptsFor(new Error('fetch failed'), controller.signal)).toBe(1);
	});
});
