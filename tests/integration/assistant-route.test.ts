import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { isHttpError } from '@sveltejs/kit';
import type pg from 'pg';
import { scenes, stories, universes, users } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import type { Provider, StreamEvent } from '../../src/lib/server/llm/providers/types';
import { ensureTestDatabase } from './test-db';

// The shared assistant endpoint wrapper: the SSE pump persists a reply only
// when the turn ends cleanly, and the gates refuse a muted story or a muted
// account. The gateway runs for real against the test database; only the
// provider is stubbed.

process.env.APP_SECRET = process.env.APP_SECRET || 'assistant-route-test-secret';

const providerSlot = vi.hoisted(() => ({ current: null as Provider | null }));

vi.mock('#lib/server/db', async () => {
	const { default: pgModule } = await import('pg');
	const { drizzle } = await import('drizzle-orm/node-postgres');
	const schemaModule = await import('../../src/lib/server/db/schema');
	const { TEST_DATABASE_URL } = await import('./test-db');
	const testPool = new pgModule.Pool({ connectionString: TEST_DATABASE_URL });
	return { db: drizzle(testPool, { schema: schemaModule }), pool: testPool };
});
vi.mock('../../src/lib/server/llm/providers/index.ts', () => ({
	providerFor: () => {
		if (!providerSlot.current) throw new Error('no stub provider set');
		return providerSlot.current;
	}
}));

const { db, pool } = (await import('#lib/server/db')) as unknown as {
	db: Database;
	pool: pg.Pool;
};
const { resetRateLimits } = await import('#lib/server/rate-limit');
const { saveAccountLlmConfig, saveStoryLlmOverride } =
	await import('../../src/lib/server/llm/config');
const { deleteChat, listChat, listChats, resolveChat } =
	await import('../../src/lib/server/llm/chat-history');
const {
	assistantSseResponse,
	requireAssistantGate,
	requireAssistantStory,
	requireAssistantUniverse,
	throwAssistantError
} = await import('../../src/lib/server/llm/assistant-route');
const { ReplyCutOffError } = await import('../../src/lib/server/llm/gateway');
const chatRoute = await import('../../src/routes/api/assistant/chat/+server');
const chatsRoute = await import('../../src/routes/api/assistant/chats/[id]/+server');
const modelsRoute = await import('../../src/routes/api/assistant/models/+server');

let userId: string;
let universeId: string;
let storyId: string;
let sceneId: string;
let chatId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	providerSlot.current = null;
	resetRateLimits();
	await pool.query('truncate table users cascade');
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
	const [story] = await db
		.insert(stories)
		.values({ universeId, ownerId: userId, title: 'S' })
		.returning({ id: stories.id });
	storyId = story.id;
	const [scene] = await db
		.insert(scenes)
		.values({
			storyId,
			globalPosition: 1,
			title: 'Scene 1',
			bodyMd: 'The first half ends here.\n\nThe second half starts here.'
		})
		.returning({ id: scenes.id });
	sceneId = scene.id;
	chatId = (await resolveChat(db, userId, { storyId }, null, 'Chat'))!;
	await configure(true);
});

afterAll(async () => {
	await pool.end();
});

async function configure(enabled: boolean) {
	await saveAccountLlmConfig(db, userId, {
		enabled,
		assistantName: '',
		persona: 'balanced',
		endpoint: 'https://api.example.com/v1',
		apiKey: 'sk',
		models: { chat: 'chat-model' },
		toolCallBudget: 8
	});
}

// A provider whose live stream is the given generator; respond is unused by the
// plain (tool-less) turns.
function streamingProvider(
	chatStream: (signal?: AbortSignal) => AsyncIterable<StreamEvent>
): Provider {
	return {
		chatStream: (_req, _conn, _http, signal) => chatStream(signal),
		async respond() {
			return { content: '', toolCalls: [] };
		},
		async listModels() {
			return [];
		}
	};
}

function sse(request: Request, enableTools = false, created = false) {
	return assistantSseResponse({
		request,
		userId,
		scope: { storyId },
		chat: { id: chatId, created },
		role: 'chat',
		enableTools,
		messages: [{ role: 'user', content: 'hello' }],
		errorMessage: 'The Assistant could not complete that request.'
	});
}

function parseFrames(text: string): StreamEvent[] {
	return text
		.split('\n\n')
		.filter((chunk) => chunk.startsWith('data: '))
		.map((chunk) => JSON.parse(chunk.slice('data: '.length)) as StreamEvent);
}

async function expectStatus(promise: Promise<unknown>, status: number) {
	try {
		await promise;
	} catch (err) {
		expect(isHttpError(err) && err.status).toBe(status);
		return;
	}
	throw new Error(`expected a ${status}`);
}

describe('assistantSseResponse', () => {
	it('streams the turn and stores the reply once on a clean done', async () => {
		providerSlot.current = streamingProvider(async function* () {
			yield { type: 'token', text: 'Hello, ' };
			yield { type: 'token', text: 'writer.' };
			yield { type: 'done' };
		});
		const response = sse(new Request('http://localhost/api/assistant/chat', { method: 'POST' }));
		expect(response.headers.get('content-type')).toBe('text/event-stream');
		const frames = parseFrames(await response.text());
		expect(frames).toEqual([
			{ type: 'token', text: 'Hello, ' },
			{ type: 'token', text: 'writer.' },
			{ type: 'done' }
		]);
		expect(await listChat(db, userId, chatId)).toEqual([
			{ role: 'assistant', content: 'Hello, writer.', meta: null }
		]);
	});

	it('stores nothing when the client aborts mid-stream', async () => {
		providerSlot.current = streamingProvider(async function* (signal) {
			yield { type: 'token', text: 'A partial ' };
			// Hold the stream open until the client goes away, then fail the way
			// an aborted fetch does.
			await new Promise<void>((resolve) => {
				if (signal?.aborted) resolve();
				else signal?.addEventListener('abort', () => resolve(), { once: true });
			});
			throw new DOMException('The operation was aborted.', 'AbortError');
		});
		const controller = new AbortController();
		const response = sse(
			new Request('http://localhost/api/assistant/chat', {
				method: 'POST',
				signal: controller.signal
			})
		);
		const reader = response.body!.getReader();
		const first = await reader.read();
		expect(parseFrames(new TextDecoder().decode(first.value))).toEqual([
			{ type: 'token', text: 'A partial ' }
		]);
		controller.abort();
		let rest = '';
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			rest += new TextDecoder().decode(value);
		}
		// No error frame for a client that has gone, and no partial reply stored.
		expect(parseFrames(rest)).toEqual([]);
		expect(await listChat(db, userId, chatId)).toEqual([]);
	});

	it('drops a chat it created when the stream stores nothing', async () => {
		providerSlot.current = streamingProvider(async function* () {
			yield { type: 'error', message: 'upstream failed' };
		});
		const response = sse(
			new Request('http://localhost/api/assistant/recap', { method: 'POST' }),
			false,
			true
		);
		await response.text();
		expect(await listChats(db, userId, { storyId })).toEqual([]);
	});

	it('loses a reply quietly when its chat was deleted mid-stream', async () => {
		providerSlot.current = streamingProvider(async function* () {
			await deleteChat(db, userId, chatId);
			yield { type: 'token', text: 'Too late.' };
			yield { type: 'done' };
		});
		const response = sse(new Request('http://localhost/api/assistant/chat', { method: 'POST' }));
		const frames = parseFrames(await response.text());
		expect(frames.at(-1)).toEqual({ type: 'done' });
		expect(await listChats(db, userId, { storyId })).toEqual([]);
	});

	it('stores nothing when the provider reports an error', async () => {
		providerSlot.current = streamingProvider(async function* () {
			yield { type: 'token', text: 'Half a thought' };
			yield { type: 'error', message: 'upstream failed' };
		});
		const response = sse(new Request('http://localhost/api/assistant/chat', { method: 'POST' }));
		const frames = parseFrames(await response.text());
		expect(frames.at(-1)).toEqual({ type: 'error', message: 'upstream failed' });
		expect(await listChat(db, userId, chatId)).toEqual([]);
	});

	it('stores nothing and sends the fallback error when the provider throws', async () => {
		providerSlot.current = streamingProvider(async function* () {
			yield { type: 'token', text: 'Half a thought' };
			throw new Error('socket hang up');
		});
		const response = sse(new Request('http://localhost/api/assistant/chat', { method: 'POST' }));
		const frames = parseFrames(await response.text());
		expect(frames.at(-1)).toEqual({
			type: 'error',
			message: 'The Assistant could not complete that request.'
		});
		expect(await listChat(db, userId, chatId)).toEqual([]);
	});

	it('attaches a proposal to the stored reply', async () => {
		const turns = [
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
			{ content: 'Split before the second half.', toolCalls: [] }
		];
		providerSlot.current = {
			async *chatStream() {
				yield { type: 'done' };
			},
			async respond() {
				return turns.shift() ?? { content: '', toolCalls: [] };
			},
			async listModels() {
				return [];
			}
		};
		const response = sse(
			new Request('http://localhost/api/assistant/chat', { method: 'POST' }),
			true
		);
		const frames = parseFrames(await response.text());
		expect(frames.at(-1)).toEqual({ type: 'done' });
		const proposal = {
			sceneId,
			sceneTitle: 'Scene 1',
			before: 'The second half',
			rationale: 'A clean change of focus.'
		};
		expect(await listChat(db, userId, chatId)).toEqual([
			{
				role: 'assistant',
				content: 'Split before the second half.',
				meta: { proposals: [proposal] }
			}
		]);
	});

	it('stores the cut-short note with a reply that hit the tool-call limit', async () => {
		await saveAccountLlmConfig(db, userId, {
			enabled: true,
			assistantName: '',
			persona: 'balanced',
			endpoint: 'https://api.example.com/v1',
			apiKey: 'sk',
			models: { chat: 'm' },
			toolCallBudget: 1
		});
		providerSlot.current = {
			async *chatStream() {
				yield { type: 'done' };
			},
			async respond(req) {
				return req.toolChoice === 'none'
					? { content: 'What I read so far.', toolCalls: [] }
					: {
							content: '',
							toolCalls: [{ id: 'c1', name: 'get_scene', arguments: JSON.stringify({ sceneId }) }]
						};
			},
			async listModels() {
				return [];
			}
		};
		const response = sse(
			new Request('http://localhost/api/assistant/chat', { method: 'POST' }),
			true
		);
		const frames = parseFrames(await response.text());
		expect(frames).toContainEqual({ type: 'stopped', reason: 'budget' });
		expect(await listChat(db, userId, chatId)).toEqual([
			{ role: 'assistant', content: 'What I read so far.', meta: { stopped: 'budget' } }
		]);
	});
});

describe('assistant gates', () => {
	it('requireAssistantGate refuses a muted story and allows it again once cleared', async () => {
		await saveStoryLlmOverride(db, storyId, { enabled: false });
		await expectStatus(requireAssistantGate(userId, storyId), 403);
		await expectStatus(requireAssistantStory(userId, storyId), 403);
		await saveStoryLlmOverride(db, storyId, { enabled: null });
		await expect(requireAssistantGate(userId, storyId)).resolves.toMatchObject({
			surfacesEnabled: true
		});
	});

	it('requireAssistantStory 404s a story the user does not own', async () => {
		const [other] = await db
			.insert(users)
			.values({ email: 'o@example.com', displayName: 'Other', passwordHash: 'x', role: 'user' })
			.returning({ id: users.id });
		await expectStatus(requireAssistantStory(other.id, storyId), 404);
	});

	it('requireAssistantUniverse checks the account gate', async () => {
		await expect(requireAssistantUniverse(userId, universeId)).resolves.toMatchObject({
			id: universeId
		});
		await configure(false);
		await expectStatus(requireAssistantUniverse(userId, universeId), 403);
	});

	it('the chat endpoint refuses a muted story and stores no turn', async () => {
		providerSlot.current = streamingProvider(async function* () {
			yield { type: 'token', text: 'should not run' };
			yield { type: 'done' };
		});
		await saveStoryLlmOverride(db, storyId, { enabled: false });
		const request = new Request('http://localhost/api/assistant/chat', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ storyId, messages: [{ role: 'user', content: 'hello' }] })
		});
		await expectStatus(
			chatRoute.POST({
				request,
				locals: { user: { id: userId } }
			} as unknown as Parameters<typeof chatRoute.POST>[0]) as Promise<unknown>,
			403
		);
		expect(await listChat(db, userId, chatId)).toEqual([]);
	});
});

describe('chats over the endpoints', () => {
	function chatPost(body: object, as = userId) {
		const request = new Request('http://localhost/api/assistant/chat', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		return chatRoute.POST({
			request,
			locals: { user: { id: as } }
		} as unknown as Parameters<typeof chatRoute.POST>[0]) as Promise<Response>;
	}

	function onChat(method: 'GET' | 'DELETE', id: string, as = userId) {
		return chatsRoute[method]({
			params: { id },
			locals: { user: { id: as } }
		} as unknown as Parameters<typeof chatsRoute.GET>[0]) as Promise<Response>;
	}

	// The chat endpoint offers tools, so a reply can come back either way.
	beforeEach(() => {
		providerSlot.current = {
			...streamingProvider(async function* () {
				yield { type: 'token', text: 'Answer.' };
				yield { type: 'done' };
			}),
			async respond() {
				return { content: 'Answer.', toolCalls: [] };
			}
		};
	});

	it('starts a new chat titled from the first message and says which', async () => {
		const response = await chatPost({
			storyId,
			messages: [{ role: 'user', content: 'Who is   Marra?' }]
		});
		await response.text();
		const newId = response.headers.get('x-chat-id')!;
		expect(newId).not.toBe(chatId);
		const chats = await listChats(db, userId, { storyId });
		expect(chats[0]).toMatchObject({ id: newId, title: 'Who is Marra?' });
		expect((await listChat(db, userId, newId)).map((m) => m.content)).toEqual([
			'Who is   Marra?',
			'Answer.'
		]);
	});

	it('continues the named chat', async () => {
		const response = await chatPost({
			storyId,
			chatId,
			messages: [{ role: 'user', content: 'Go on.' }]
		});
		await response.text();
		expect(response.headers.get('x-chat-id')).toBe(chatId);
		expect(await listChat(db, userId, chatId)).toHaveLength(2);
		expect(await listChats(db, userId, { storyId })).toHaveLength(1);
	});

	it('404s a chat from another scope or another writer', async () => {
		const universeChat = (await resolveChat(db, userId, { universeId }, null, 'U'))!;
		await expectStatus(
			chatPost({ storyId, chatId: universeChat, messages: [{ role: 'user', content: 'x' }] }),
			404
		);
		const [other] = await db
			.insert(users)
			.values({ email: 'o@example.com', displayName: 'O', passwordHash: 'x', role: 'user' })
			.returning({ id: users.id });
		await expectStatus(onChat('GET', chatId, other.id), 404);
		await expectStatus(onChat('DELETE', chatId, other.id), 404);
		expect(await listChats(db, userId, { storyId })).toHaveLength(1);
	});

	it('starts a new chat under the id the panel picked, and reaches it again by that id', async () => {
		const picked = '0f8fad5b-d9cb-469f-a165-70867728950e';
		const first = await chatPost({
			storyId,
			newChatId: picked,
			messages: [{ role: 'user', content: 'First.' }]
		});
		await first.text();
		expect(first.headers.get('x-chat-id')).toBe(picked);
		expect(first.headers.get('x-chat-created')).toBe('1');
		// The panel never learned the id (stopped early), so it sends it again.
		const again = await chatPost({
			storyId,
			newChatId: picked,
			messages: [{ role: 'user', content: 'Second.' }]
		});
		await again.text();
		expect(again.headers.get('x-chat-id')).toBe(picked);
		// The chat already held the first send: its stored title comes back.
		expect(again.headers.get('x-chat-created')).toBe('0');
		expect(decodeURIComponent(again.headers.get('x-chat-title') ?? '')).toBe('First.');
		expect((await listChat(db, userId, picked)).map((m) => m.content)).toEqual([
			'First.',
			'Answer.',
			'Second.',
			'Answer.'
		]);
	});

	it("refuses a picked id that is another writer's chat, another story's, or not a uuid", async () => {
		const [other] = await db
			.insert(users)
			.values({ email: 'p@example.com', displayName: 'P', passwordHash: 'x', role: 'user' })
			.returning({ id: users.id });
		const [otherUniverse] = await db
			.insert(universes)
			.values({ ownerId: other.id, name: 'P' })
			.returning({ id: universes.id });
		const [otherStory] = await db
			.insert(stories)
			.values({ universeId: otherUniverse.id, ownerId: other.id, title: 'P' })
			.returning({ id: stories.id });
		await saveAccountLlmConfig(db, other.id, {
			enabled: true,
			assistantName: '',
			persona: 'balanced',
			endpoint: 'https://api.example.com/v1',
			apiKey: 'sk',
			models: { chat: 'chat-model' },
			toolCallBudget: 8
		});
		// Another writer, on their own story, naming this writer's chat.
		await expectStatus(
			chatPost(
				{
					storyId: otherStory.id,
					newChatId: chatId,
					messages: [{ role: 'user', content: 'x' }]
				},
				other.id
			),
			404
		);
		// The same writer, naming a chat that belongs to another story.
		const [second] = await db
			.insert(stories)
			.values({ universeId, ownerId: userId, title: 'S2' })
			.returning({ id: stories.id });
		await expectStatus(
			chatPost({
				storyId: second.id,
				newChatId: chatId,
				messages: [{ role: 'user', content: 'x' }]
			}),
			404
		);
		await expectStatus(
			chatPost({ storyId, newChatId: 'nope', messages: [{ role: 'user', content: 'x' }] }),
			400
		);
		expect(await listChat(db, userId, chatId)).toHaveLength(0);
	});

	it('does not load or delete a chat whose story is in the trash', async () => {
		await db.update(stories).set({ deletedAt: new Date() });
		await expectStatus(onChat('GET', chatId), 404);
		await expectStatus(onChat('DELETE', chatId), 404);
		await db.update(stories).set({ deletedAt: null });
		expect(await listChats(db, userId, { storyId })).toHaveLength(1);
	});

	it('runs a chat on its own model and keeps that choice with the chat', async () => {
		const models: string[] = [];
		providerSlot.current = {
			...streamingProvider(async function* () {
				yield { type: 'token', text: 'Answer.' };
				yield { type: 'done' };
			}),
			chatStream: (req) => {
				models.push(req.model);
				return (async function* (): AsyncIterable<StreamEvent> {
					yield { type: 'token', text: 'Answer.' };
					yield { type: 'done' };
				})();
			},
			async respond(req) {
				models.push(req.model);
				return { content: 'Answer.', toolCalls: [] };
			}
		};
		await (
			await chatPost({
				storyId,
				chatId,
				messages: [{ role: 'user', content: 'Hi.' }],
				settings: { model: 'other-model', effort: 'bogus' }
			})
		).text();
		expect(models.at(-1)).toBe('other-model');
		expect((await (await onChat('GET', chatId)).json()).settings).toEqual({ model: 'other-model' });

		// Without a setting the chat goes back to the default, and so does the stored choice.
		await (
			await chatPost({ storyId, chatId, messages: [{ role: 'user', content: 'Again.' }] })
		).text();
		expect(models.at(-1)).toBe('chat-model');
		expect((await (await onChat('GET', chatId)).json()).settings).toEqual({});
	});

	it('loads and deletes a chat', async () => {
		await (
			await chatPost({ storyId, chatId, messages: [{ role: 'user', content: 'Hi.' }] })
		).text();
		const loaded = await (await onChat('GET', chatId)).json();
		expect(loaded).toEqual({
			messages: [
				{ role: 'user', content: 'Hi.', meta: null },
				{ role: 'assistant', content: 'Answer.', meta: null }
			],
			summarised: false,
			settings: {}
		});
		expect((await onChat('DELETE', chatId)).status).toBe(200);
		expect(await listChats(db, userId, { storyId })).toEqual([]);
	});
});

describe('the model list', () => {
	function getModels() {
		return modelsRoute.GET({
			locals: { user: { id: userId } }
		} as unknown as Parameters<typeof modelsRoute.GET>[0]) as Promise<Response>;
	}

	it("lists the endpoint's models with the ones already set", async () => {
		providerSlot.current = {
			...streamingProvider(async function* () {}),
			async listModels() {
				return [{ id: 'b-model' }, { id: 'a-model' }];
			}
		};
		expect(await (await getModels()).json()).toEqual({
			models: ['a-model', 'b-model', 'chat-model'],
			complete: true
		});
	});

	it('still offers the models already set when the endpoint cannot list them', async () => {
		providerSlot.current = {
			...streamingProvider(async function* () {}),
			async listModels() {
				throw new Error('no listing');
			}
		};
		expect(await (await getModels()).json()).toEqual({ models: ['chat-model'], complete: false });
	});

	it('refuses while the Assistant is off', async () => {
		await configure(false);
		await expectStatus(getModels(), 403);
	});
});

describe('throwAssistantError', () => {
	it('passes a cut-off reply on with its own advice', () => {
		try {
			throwAssistantError(new ReplyCutOffError('Raise Longest reply.'), 'Generic.');
		} catch (err) {
			expect(isHttpError(err) && err.status).toBe(502);
			expect(isHttpError(err) && err.body.message).toBe('Raise Longest reply.');
		}
		expect.assertions(2);
	});
});
