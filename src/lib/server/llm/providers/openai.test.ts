import { describe, it, expect } from 'vitest';
import { openaiProvider } from './openai';
import type { Connection, HttpRequest, HttpResponse, StreamEvent } from './types';

function encode(parts: string[]): AsyncIterable<Uint8Array> {
	const encoder = new TextEncoder();
	return {
		async *[Symbol.asyncIterator]() {
			for (const part of parts) yield encoder.encode(part);
		}
	};
}

function sseResponse(frames: string[]): HttpResponse {
	return {
		status: 200,
		headers: { 'content-type': 'text/event-stream' },
		body: encode(frames),
		text: async () => frames.join('')
	};
}

function jsonResponse(status: number, obj: unknown): HttpResponse {
	const text = JSON.stringify(obj);
	return {
		status,
		headers: { 'content-type': 'application/json' },
		body: encode([text]),
		text: async () => text
	};
}

const conn: Connection = { endpoint: 'http://local/v1', apiKey: '' };

async function drain(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
	const out: StreamEvent[] = [];
	for await (const event of stream) out.push(event);
	return out;
}

describe('openaiProvider.chatStream', () => {
	it('parses streamed token deltas and the [DONE] terminator', async () => {
		const frames = [
			'data: {"choices":[{"delta":{"content":"Hello"}}]}\n',
			'data: {"choices":[{"delta":{"content":", world"}}]}\n',
			'data: [DONE]\n'
		];
		let calledUrl = '';
		const http: HttpRequest = async (url) => {
			calledUrl = url;
			return sseResponse(frames);
		};
		const events = await drain(
			openaiProvider.chatStream({ model: 'm', messages: [], maxTokens: 16 }, conn, http)
		);
		expect(calledUrl).toBe('http://local/v1/chat/completions');
		expect(events).toEqual([
			{ type: 'token', text: 'Hello' },
			{ type: 'token', text: ', world' },
			{ type: 'done' }
		]);
	});

	it('reassembles a frame split across chunk boundaries', async () => {
		const frames = ['data: {"choi', 'ces":[{"delta":{"content":"Hi"}}]}\n', 'data: [DONE]\n'];
		const http: HttpRequest = async () => sseResponse(frames);
		const events = await drain(
			openaiProvider.chatStream({ model: 'm', messages: [], maxTokens: 16 }, conn, http)
		);
		expect(events).toEqual([{ type: 'token', text: 'Hi' }, { type: 'done' }]);
	});

	it('emits a single error event on a non-2xx status', async () => {
		const http: HttpRequest = async () => jsonResponse(401, { error: 'bad key' });
		const events = await drain(
			openaiProvider.chatStream({ model: 'm', messages: [], maxTokens: 16 }, conn, http)
		);
		expect(events).toHaveLength(1);
		expect(events[0].type).toBe('error');
	});

	it('asks for streamed usage and surfaces it as a usage event', async () => {
		const frames = [
			'data: {"choices":[{"delta":{"content":"Hi"}}]}\n',
			'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":2}}\n',
			'data: [DONE]\n'
		];
		let sentBody: Record<string, unknown> = {};
		const http: HttpRequest = async (_url, init) => {
			sentBody = JSON.parse(init.body ?? '{}');
			return sseResponse(frames);
		};
		const events = await drain(
			openaiProvider.chatStream({ model: 'm', messages: [], maxTokens: 16 }, conn, http)
		);
		expect(sentBody.stream_options).toEqual({ include_usage: true });
		expect(events).toEqual([
			{ type: 'token', text: 'Hi' },
			{ type: 'usage', usage: { promptTokens: 9, completionTokens: 2 } },
			{ type: 'done' }
		]);
	});

	it('emits an error event when the transport throws', async () => {
		const http: HttpRequest = async () => {
			throw new Error('connection refused');
		};
		const events = await drain(
			openaiProvider.chatStream({ model: 'm', messages: [], maxTokens: 16 }, conn, http)
		);
		expect(events).toEqual([{ type: 'error', message: 'connection refused' }]);
	});
});

describe('openaiProvider.respond', () => {
	it('returns the message content and no tool calls', async () => {
		const http: HttpRequest = async () =>
			jsonResponse(200, { choices: [{ message: { content: 'Done.' } }] });
		const result = await openaiProvider.respond(
			{ model: 'm', messages: [], maxTokens: 16 },
			conn,
			http
		);
		expect(result).toEqual({ content: 'Done.', toolCalls: [] });
	});

	it('parses tool calls from the response message', async () => {
		const http: HttpRequest = async () =>
			jsonResponse(200, {
				choices: [
					{
						message: {
							content: '',
							tool_calls: [
								{
									id: 'c1',
									type: 'function',
									function: { name: 'get_scene', arguments: '{"sceneId":"s1"}' }
								}
							]
						}
					}
				]
			});
		const result = await openaiProvider.respond(
			{ model: 'm', messages: [], maxTokens: 16 },
			conn,
			http
		);
		expect(result.toolCalls).toEqual([
			{ id: 'c1', name: 'get_scene', arguments: '{"sceneId":"s1"}' }
		]);
	});

	it('sends the tools array and serialises tool-result turns', async () => {
		let sentBody: Record<string, unknown> = {};
		const http: HttpRequest = async (_url, init) => {
			sentBody = JSON.parse(init.body ?? '{}');
			return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] });
		};
		await openaiProvider.respond(
			{
				model: 'm',
				maxTokens: 16,
				messages: [
					{ role: 'user', content: 'hi' },
					{ role: 'tool', content: 'result', toolCallId: 'c1' }
				],
				tools: [{ name: 'get_scene', description: 'd', parameters: { type: 'object' } }]
			},
			conn,
			http
		);
		expect((sentBody.tools as unknown[])?.length).toBe(1);
		expect((sentBody.messages as { role: string }[])[1]).toMatchObject({
			role: 'tool',
			tool_call_id: 'c1',
			content: 'result'
		});
	});

	it('throws on a non-2xx status', async () => {
		const http: HttpRequest = async () => jsonResponse(500, { error: 'boom' });
		await expect(
			openaiProvider.respond({ model: 'm', messages: [], maxTokens: 16 }, conn, http)
		).rejects.toThrow();
	});

	it('carries the reported token usage through', async () => {
		const http: HttpRequest = async () =>
			jsonResponse(200, {
				choices: [{ message: { content: 'ok' } }],
				usage: { prompt_tokens: 12, completion_tokens: 3 }
			});
		const result = await openaiProvider.respond(
			{ model: 'm', messages: [], maxTokens: 16 },
			conn,
			http
		);
		expect(result.usage).toEqual({ promptTokens: 12, completionTokens: 3 });
	});

	it('normalises every endpoint variant to the completions path', async () => {
		const urls: string[] = [];
		const http: HttpRequest = async (url) => {
			urls.push(url);
			return jsonResponse(200, { choices: [{ message: { content: '' } }] });
		};
		for (const endpoint of [
			'http://h',
			'http://h/',
			'http://h/v1',
			'http://h/v1/chat/completions'
		]) {
			await openaiProvider.respond(
				{ model: 'm', messages: [], maxTokens: 1 },
				{ endpoint, apiKey: '' },
				http
			);
		}
		expect(urls).toEqual([
			'http://h/v1/chat/completions',
			'http://h/v1/chat/completions',
			'http://h/v1/chat/completions',
			'http://h/v1/chat/completions'
		]);
	});

	it("leaves Gemini's /openai compatibility base alone", async () => {
		const urls: string[] = [];
		const http: HttpRequest = async (url) => {
			urls.push(url);
			return jsonResponse(200, { choices: [{ message: { content: '' } }] });
		};
		for (const endpoint of ['http://h/v1beta/openai', 'http://h/v1beta/openai/']) {
			await openaiProvider.respond(
				{ model: 'm', messages: [], maxTokens: 1 },
				{ endpoint, apiKey: '' },
				http
			);
		}
		expect(urls).toEqual([
			'http://h/v1beta/openai/chat/completions',
			'http://h/v1beta/openai/chat/completions'
		]);
	});
});

describe('openaiProvider.listModels', () => {
	it('returns the model ids, de-duplicated and sorted', async () => {
		let calledUrl = '';
		const http: HttpRequest = async (url) => {
			calledUrl = url;
			return jsonResponse(200, {
				data: [{ id: 'llama3.1:8b' }, { id: 'gemma2' }, { id: 'llama3.1:8b' }]
			});
		};
		const models = await openaiProvider.listModels({ endpoint: 'http://h/v1', apiKey: '' }, http);
		expect(calledUrl).toBe('http://h/v1/models');
		expect(models).toEqual([{ id: 'gemma2' }, { id: 'llama3.1:8b' }]);
	});

	it('carries OpenRouter-style per-token pricing through when reported', async () => {
		const http: HttpRequest = async () =>
			jsonResponse(200, {
				data: [
					{ id: 'paid', pricing: { prompt: '0.000003', completion: '0.000015' } },
					{ id: 'unpriced' },
					{ id: 'free', pricing: { prompt: '0', completion: '0' } }
				]
			});
		const models = await openaiProvider.listModels({ endpoint: 'http://h/v1', apiKey: '' }, http);
		expect(models).toEqual([
			{ id: 'free' },
			{ id: 'paid', pricing: { prompt: 0.000003, completion: 0.000015 } },
			{ id: 'unpriced' }
		]);
	});

	it('derives the models path from a full completions endpoint', async () => {
		let calledUrl = '';
		const http: HttpRequest = async (url) => {
			calledUrl = url;
			return jsonResponse(200, { data: [] });
		};
		await openaiProvider.listModels({ endpoint: 'http://h/v1/chat/completions', apiKey: '' }, http);
		expect(calledUrl).toBe('http://h/v1/models');
	});

	it('sends the key as a bearer token when set', async () => {
		let auth: string | undefined;
		const http: HttpRequest = async (_url, init) => {
			auth = init.headers['authorization'];
			return jsonResponse(200, { data: [{ id: 'm' }] });
		};
		await openaiProvider.listModels({ endpoint: 'http://h/v1', apiKey: 'sk-xyz' }, http);
		expect(auth).toBe('Bearer sk-xyz');
	});

	it('throws on a non-2xx status', async () => {
		const http: HttpRequest = async () => jsonResponse(401, { error: 'unauthorized' });
		await expect(
			openaiProvider.listModels({ endpoint: 'http://h/v1', apiKey: '' }, http)
		).rejects.toThrow();
	});
});
