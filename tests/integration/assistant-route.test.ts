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

vi.mock('$lib/server/db', async () => {
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

const { db, pool } = (await import('$lib/server/db')) as unknown as {
	db: Database;
	pool: pg.Pool;
};
const { resetRateLimits } = await import('$lib/server/rate-limit');
const { saveAccountLlmConfig, saveStoryLlmOverride } =
	await import('../../src/lib/server/llm/config');
const { listChat } = await import('../../src/lib/server/llm/chat-history');
const {
	assistantSseResponse,
	requireAssistantGate,
	requireAssistantStory,
	requireAssistantUniverse
} = await import('../../src/lib/server/llm/assistant-route');
const chatRoute = await import('../../src/routes/api/assistant/chat/+server');

let userId: string;
let universeId: string;
let storyId: string;
let sceneId: string;

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

function sse(request: Request, enableTools = false) {
	return assistantSseResponse({
		request,
		userId,
		scope: { storyId },
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
		expect(await listChat(db, userId, { storyId })).toEqual([
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
		expect(await listChat(db, userId, { storyId })).toEqual([]);
	});

	it('stores nothing when the provider reports an error', async () => {
		providerSlot.current = streamingProvider(async function* () {
			yield { type: 'token', text: 'Half a thought' };
			yield { type: 'error', message: 'upstream failed' };
		});
		const response = sse(new Request('http://localhost/api/assistant/chat', { method: 'POST' }));
		const frames = parseFrames(await response.text());
		expect(frames.at(-1)).toEqual({ type: 'error', message: 'upstream failed' });
		expect(await listChat(db, userId, { storyId })).toEqual([]);
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
		expect(await listChat(db, userId, { storyId })).toEqual([]);
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
		expect(await listChat(db, userId, { storyId })).toEqual([
			{
				role: 'assistant',
				content: 'Split before the second half.',
				meta: { proposals: [proposal] }
			}
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
		expect(await listChat(db, userId, { storyId })).toEqual([]);
	});
});
