import { describe, it, expect } from 'vitest';
import { anthropicProvider } from './anthropic';
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

const conn: Connection = { endpoint: 'https://api.anthropic.com', apiKey: 'sk-ant-x' };

async function drain(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
	const out: StreamEvent[] = [];
	for await (const event of stream) out.push(event);
	return out;
}

describe('anthropicProvider.respond', () => {
	it('sends the Anthropic headers and hoists system messages', async () => {
		let calledUrl = '';
		let headers: Record<string, string> = {};
		let sentBody: Record<string, unknown> = {};
		const http: HttpRequest = async (url, init) => {
			calledUrl = url;
			headers = init.headers;
			sentBody = JSON.parse(init.body ?? '{}');
			return jsonResponse(200, { content: [{ type: 'text', text: 'ok' }] });
		};
		const result = await anthropicProvider.respond(
			{
				model: 'claude-x',
				maxTokens: 16,
				messages: [
					{ role: 'system', content: 'persona' },
					{ role: 'system', content: 'context' },
					{ role: 'user', content: 'hi' }
				]
			},
			conn,
			http
		);
		expect(calledUrl).toBe('https://api.anthropic.com/v1/messages');
		expect(headers['x-api-key']).toBe('sk-ant-x');
		expect(headers['anthropic-version']).toBe('2023-06-01');
		expect(headers['authorization']).toBeUndefined();
		expect(sentBody.system).toBe('persona\n\ncontext');
		expect(sentBody.max_tokens).toBe(16);
		expect(sentBody.messages).toEqual([{ role: 'user', content: 'hi' }]);
		expect(result.content).toBe('ok');
	});

	it('maps tool specs and parses tool_use blocks from the response', async () => {
		let sentBody: Record<string, unknown> = {};
		const http: HttpRequest = async (_url, init) => {
			sentBody = JSON.parse(init.body ?? '{}');
			return jsonResponse(200, {
				content: [
					{ type: 'text', text: 'Looking...' },
					{ type: 'tool_use', id: 'c1', name: 'get_scene', input: { sceneId: 's1' } }
				]
			});
		};
		const result = await anthropicProvider.respond(
			{
				model: 'claude-x',
				maxTokens: 16,
				messages: [{ role: 'user', content: 'hi' }],
				tools: [{ name: 'get_scene', description: 'd', parameters: { type: 'object' } }]
			},
			conn,
			http
		);
		expect(sentBody.tools).toEqual([
			{ name: 'get_scene', description: 'd', input_schema: { type: 'object' } }
		]);
		expect(sentBody.tool_choice).toEqual({ type: 'auto' });
		expect(result.content).toBe('Looking...');
		expect(result.toolCalls).toEqual([
			{ id: 'c1', name: 'get_scene', arguments: '{"sceneId":"s1"}' }
		]);
	});

	it('round-trips tool turns, merging adjacent tool results into one user turn', async () => {
		let sentBody: Record<string, unknown> = {};
		const http: HttpRequest = async (_url, init) => {
			sentBody = JSON.parse(init.body ?? '{}');
			return jsonResponse(200, { content: [{ type: 'text', text: 'done' }] });
		};
		await anthropicProvider.respond(
			{
				model: 'claude-x',
				maxTokens: 16,
				messages: [
					{ role: 'user', content: 'hi' },
					{
						role: 'assistant',
						content: 'calling',
						toolCalls: [
							{ id: 'c1', name: 'get_scene', arguments: '{"sceneId":"s1"}' },
							{ id: 'c2', name: 'list_scenes', arguments: 'not json' }
						]
					},
					{ role: 'tool', content: 'r1', toolCallId: 'c1' },
					{ role: 'tool', content: 'r2', toolCallId: 'c2' }
				]
			},
			conn,
			http
		);
		expect(sentBody.messages).toEqual([
			{ role: 'user', content: 'hi' },
			{
				role: 'assistant',
				content: [
					{ type: 'text', text: 'calling' },
					{ type: 'tool_use', id: 'c1', name: 'get_scene', input: { sceneId: 's1' } },
					{ type: 'tool_use', id: 'c2', name: 'list_scenes', input: {} }
				]
			},
			{
				role: 'user',
				content: [
					{ type: 'tool_result', tool_use_id: 'c1', content: 'r1' },
					{ type: 'tool_result', tool_use_id: 'c2', content: 'r2' }
				]
			}
		]);
	});

	it('carries the reported token usage through', async () => {
		const http: HttpRequest = async () =>
			jsonResponse(200, {
				content: [{ type: 'text', text: 'ok' }],
				usage: { input_tokens: 12, output_tokens: 3 }
			});
		const result = await anthropicProvider.respond(
			{ model: 'claude-x', messages: [], maxTokens: 16 },
			conn,
			http
		);
		expect(result.usage).toEqual({ promptTokens: 12, completionTokens: 3 });
	});

	it('throws on a non-2xx status', async () => {
		const http: HttpRequest = async () => jsonResponse(401, { error: 'bad key' });
		await expect(
			anthropicProvider.respond({ model: 'claude-x', messages: [], maxTokens: 16 }, conn, http)
		).rejects.toThrow(/401/);
	});

	it('accepts a base already ending in /v1', async () => {
		let calledUrl = '';
		const http: HttpRequest = async (url) => {
			calledUrl = url;
			return jsonResponse(200, { content: [] });
		};
		await anthropicProvider.respond(
			{ model: 'claude-x', messages: [], maxTokens: 1 },
			{ endpoint: 'https://api.anthropic.com/v1', apiKey: '' },
			http
		);
		expect(calledUrl).toBe('https://api.anthropic.com/v1/messages');
	});
});

describe('anthropicProvider.chatStream', () => {
	it('parses text deltas, usage, and the message_stop terminator', async () => {
		const frames = [
			'event: message_start\n',
			'data: {"type":"message_start","message":{"usage":{"input_tokens":9}}}\n',
			'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}\n',
			'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"x"}}\n',
			'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}\n',
			'data: {"type":"message_delta","delta":{},"usage":{"output_tokens":2}}\n',
			'data: {"type":"message_stop"}\n'
		];
		const http: HttpRequest = async () => sseResponse(frames);
		const events = await drain(
			anthropicProvider.chatStream({ model: 'claude-x', messages: [], maxTokens: 16 }, conn, http)
		);
		expect(events).toEqual([
			{ type: 'token', text: 'Hel' },
			{ type: 'token', text: 'lo' },
			{ type: 'usage', usage: { promptTokens: 9, completionTokens: 2 } },
			{ type: 'done' }
		]);
	});

	it('closes the stream when it ends without message_stop', async () => {
		const frames = [
			'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n'
		];
		const http: HttpRequest = async () => sseResponse(frames);
		const events = await drain(
			anthropicProvider.chatStream({ model: 'claude-x', messages: [], maxTokens: 16 }, conn, http)
		);
		expect(events).toEqual([{ type: 'token', text: 'Hi' }, { type: 'done' }]);
	});

	it('surfaces a streamed error frame as an error event', async () => {
		const frames = ['data: {"type":"error","error":{"message":"overloaded"}}\n'];
		const http: HttpRequest = async () => sseResponse(frames);
		const events = await drain(
			anthropicProvider.chatStream({ model: 'claude-x', messages: [], maxTokens: 16 }, conn, http)
		);
		expect(events).toEqual([{ type: 'error', message: 'overloaded' }]);
	});

	it('emits a single error event on a non-2xx status', async () => {
		const http: HttpRequest = async () => jsonResponse(529, { error: 'overloaded' });
		const events = await drain(
			anthropicProvider.chatStream({ model: 'claude-x', messages: [], maxTokens: 16 }, conn, http)
		);
		expect(events).toHaveLength(1);
		expect(events[0].type).toBe('error');
	});
});

describe('anthropicProvider.listModels', () => {
	it('lists model ids, de-duplicated and sorted', async () => {
		let calledUrl = '';
		const http: HttpRequest = async (url) => {
			calledUrl = url;
			return jsonResponse(200, {
				data: [{ id: 'claude-b' }, { id: 'claude-a' }, { id: 'claude-b' }]
			});
		};
		const models = await anthropicProvider.listModels(conn, http);
		expect(calledUrl).toBe('https://api.anthropic.com/v1/models');
		expect(models).toEqual([{ id: 'claude-a' }, { id: 'claude-b' }]);
	});

	it('throws on a non-2xx status', async () => {
		const http: HttpRequest = async () => jsonResponse(401, { error: 'unauthorized' });
		await expect(anthropicProvider.listModels(conn, http)).rejects.toThrow();
	});
});
