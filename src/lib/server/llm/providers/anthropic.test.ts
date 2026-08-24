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

describe('anthropicProvider web search', () => {
	async function bodyFor(req: Parameters<typeof anthropicProvider.respond>[0]) {
		let sent: Record<string, unknown> = {};
		const http: HttpRequest = async (_url, init) => {
			sent = JSON.parse(init.body ?? '{}');
			return jsonResponse(200, { content: [{ type: 'text', text: 'ok' }] });
		};
		await anthropicProvider.respond(req, conn, http);
		return sent;
	}

	it('attaches the server tool only when the turn asks for it', async () => {
		const withSearch = await bodyFor({
			model: 'claude-opus-5',
			messages: [],
			maxTokens: 16,
			webSearch: true
		});
		expect(withSearch.tools).toEqual([
			{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }
		]);
		expect(withSearch.tool_choice).toEqual({ type: 'auto' });

		const without = await bodyFor({ model: 'claude-opus-5', messages: [], maxTokens: 16 });
		expect(without).not.toHaveProperty('tools');
		expect(without).not.toHaveProperty('tool_choice');
	});

	it('falls back to the original tool on a model without the filtering one', async () => {
		const body = await bodyFor({
			model: 'claude-3-5-haiku-20241022',
			messages: [],
			maxTokens: 16,
			webSearch: true
		});
		expect(body.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }]);
	});

	it("sits alongside Codex's own tools, and a concluding round forbids both", async () => {
		const body = await bodyFor({
			model: 'claude-opus-5',
			messages: [],
			maxTokens: 16,
			webSearch: true,
			toolChoice: 'none',
			tools: [{ name: 'get_scene', description: 'Read a scene', parameters: { type: 'object' } }]
		});
		expect(body.tools).toEqual([
			{ name: 'get_scene', description: 'Read a scene', input_schema: { type: 'object' } },
			{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }
		]);
		expect(body.tool_choice).toEqual({ type: 'none' });
	});

	it('ignores the OpenAI-compatible extra parameters entirely', async () => {
		const body = await bodyFor({
			model: 'claude-opus-5',
			messages: [],
			maxTokens: 16,
			extraParams: { top_p: 0.9, chat_template_kwargs: { enable_thinking: false } }
		});
		expect(body).not.toHaveProperty('top_p');
		expect(body).not.toHaveProperty('chat_template_kwargs');
	});

	it('reads the answer past the search blocks the server adds', async () => {
		const http: HttpRequest = async () =>
			jsonResponse(200, {
				content: [
					{
						type: 'server_tool_use',
						id: 'srv1',
						name: 'web_search',
						input: { query: 'Waterdeep' }
					},
					{
						type: 'web_search_tool_result',
						tool_use_id: 'srv1',
						content: [{ type: 'web_search_result', title: 'Waterdeep', url: 'http://x' }]
					},
					{ type: 'text', text: 'Canon puts it on the Sword Coast.' }
				]
			});
		const result = await anthropicProvider.respond(
			{ model: 'claude-opus-5', messages: [], maxTokens: 16, webSearch: true },
			conn,
			http
		);
		// The search is the provider's business: only the prose comes back, and
		// nothing here is mistaken for a tool call Codex has to run.
		expect(result.content).toBe('Canon puts it on the Sword Coast.');
		expect(result.toolCalls).toEqual([]);
	});
});

describe('anthropicProvider.respond', () => {
	it('normalises stop_reason onto the neutral finish reason', async () => {
		const seen: (string | undefined)[] = [];
		for (const reason of ['end_turn', 'max_tokens', 'tool_use', 'refusal', undefined]) {
			const http: HttpRequest = async () =>
				jsonResponse(200, {
					content: [{ type: 'text', text: 'x' }],
					...(reason ? { stop_reason: reason } : {})
				});
			const result = await anthropicProvider.respond(
				{ model: 'claude-x', messages: [], maxTokens: 16 },
				conn,
				http
			);
			seen.push(result.finishReason);
		}
		expect(seen).toEqual(['stop', 'length', 'toolCalls', 'other', undefined]);
	});

	it('ignores a tuned temperature', async () => {
		let sentBody: Record<string, unknown> = {};
		const http: HttpRequest = async (_url, init) => {
			sentBody = JSON.parse(init.body ?? '{}');
			return jsonResponse(200, { content: [{ type: 'text', text: 'ok' }] });
		};
		await anthropicProvider.respond(
			{ model: 'claude-x', messages: [], maxTokens: 16, tuning: { temperature: 0.1 } },
			conn,
			http
		);
		expect(sentBody).not.toHaveProperty('temperature');
	});

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
		// The system prompt and the last user block carry cache markers, so the
		// stable prefix (tools + system + earlier turns) is cached across the
		// turns of a chat and the rounds of a tool loop.
		expect(sentBody.system).toEqual([
			{ type: 'text', text: 'persona\n\ncontext', cache_control: { type: 'ephemeral' } }
		]);
		expect(sentBody.max_tokens).toBe(16);
		expect(sentBody.messages).toEqual([
			{
				role: 'user',
				content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }]
			}
		]);
		expect(result.content).toBe('ok');
	});

	it('maps tuning to adaptive thinking and output_config, omitted when unset', async () => {
		let sentBody: Record<string, unknown> = {};
		const http: HttpRequest = async (url, init) => {
			sentBody = JSON.parse(init.body ?? '{}');
			return jsonResponse(200, { content: [{ type: 'text', text: 'ok' }] });
		};
		const base = {
			model: 'claude-x',
			maxTokens: 16,
			messages: [{ role: 'user' as const, content: 'hi' }]
		};
		await anthropicProvider.respond(
			{ ...base, tuning: { thinking: true, effort: 'xhigh' } },
			conn,
			http
		);
		expect(sentBody.thinking).toEqual({ type: 'adaptive' });
		expect(sentBody.output_config).toEqual({ effort: 'xhigh' });

		// Thinking off means no thinking field at all, never an explicit
		// "disabled" (rejected by models where thinking is always on).
		await anthropicProvider.respond({ ...base, tuning: { effort: 'low' } }, conn, http);
		expect(sentBody.thinking).toBeUndefined();
		expect(sentBody.output_config).toEqual({ effort: 'low' });

		await anthropicProvider.respond(base, conn, http);
		expect(sentBody.thinking).toBeUndefined();
		expect(sentBody.output_config).toBeUndefined();
	});

	it('captures thinking blocks on tool turns and echoes them back verbatim', async () => {
		const blocks = [
			{ type: 'thinking', thinking: 'hmm', signature: 'sig' },
			{ type: 'text', text: 'checking' },
			{ type: 'tool_use', id: 'call-1', name: 'get_scene', input: { id: 's1' } }
		];
		let sentBody: Record<string, unknown> = {};
		const http: HttpRequest = async (url, init) => {
			sentBody = JSON.parse(init.body ?? '{}');
			return jsonResponse(200, { content: blocks });
		};
		const response = await anthropicProvider.respond(
			{
				model: 'claude-x',
				maxTokens: 16,
				messages: [{ role: 'user', content: 'review' }],
				tuning: { thinking: true }
			},
			conn,
			http
		);
		expect(response.toolCalls).toHaveLength(1);
		expect(response.raw).toEqual(blocks);

		// The next turn of the loop replays the captured blocks unchanged.
		await anthropicProvider.respond(
			{
				model: 'claude-x',
				maxTokens: 16,
				messages: [
					{ role: 'user', content: 'review' },
					{
						role: 'assistant',
						content: 'checking',
						toolCalls: response.toolCalls,
						raw: response.raw
					},
					{ role: 'tool', content: 'the scene text', toolCallId: 'call-1' }
				]
			},
			conn,
			http
		);
		const messages = sentBody.messages as { role: string; content: unknown }[];
		expect(messages[1]).toEqual({ role: 'assistant', content: blocks });
	});

	it('does not capture raw blocks for a plain text response', async () => {
		const http: HttpRequest = async () =>
			jsonResponse(200, { content: [{ type: 'text', text: 'just text' }] });
		const response = await anthropicProvider.respond(
			{ model: 'claude-x', maxTokens: 16, messages: [{ role: 'user', content: 'hi' }] },
			conn,
			http
		);
		expect(response.raw).toBeUndefined();
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

	it('keeps the tools and sends tool_choice none on a concluding round', async () => {
		let sentBody: Record<string, unknown> = {};
		const http: HttpRequest = async (_url, init) => {
			sentBody = JSON.parse(init.body ?? '{}');
			return jsonResponse(200, { content: [{ type: 'text', text: 'done' }] });
		};
		await anthropicProvider.respond(
			{
				model: 'claude-x',
				maxTokens: 16,
				messages: [{ role: 'user', content: 'hi' }],
				tools: [{ name: 'get_scene', description: 'd', parameters: { type: 'object' } }],
				toolChoice: 'none'
			},
			conn,
			http
		);
		expect(sentBody.tools).toEqual([
			{ name: 'get_scene', description: 'd', input_schema: { type: 'object' } }
		]);
		expect(sentBody.tool_choice).toEqual({ type: 'none' });
	});

	it('omits the cached share when nothing was read from cache', async () => {
		const http: HttpRequest = async () =>
			jsonResponse(200, {
				content: [{ type: 'text', text: 'ok' }],
				usage: { input_tokens: 100, output_tokens: 20 }
			});
		const result = await anthropicProvider.respond(
			{ model: 'claude-x', maxTokens: 16, messages: [] },
			conn,
			http
		);
		expect(result.usage).toEqual({ promptTokens: 100, completionTokens: 20 });
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
					{
						type: 'tool_result',
						tool_use_id: 'c2',
						content: 'r2',
						cache_control: { type: 'ephemeral' }
					}
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

	it('counts cached tokens into the prompt total', async () => {
		const http: HttpRequest = async () =>
			jsonResponse(200, {
				content: [{ type: 'text', text: 'ok' }],
				usage: {
					input_tokens: 12,
					cache_creation_input_tokens: 100,
					cache_read_input_tokens: 888,
					output_tokens: 3
				}
			});
		const result = await anthropicProvider.respond(
			{ model: 'claude-x', messages: [], maxTokens: 16 },
			conn,
			http
		);
		expect(result.usage).toEqual({
			promptTokens: 1000,
			completionTokens: 3,
			cachedPromptTokens: 888
		});
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

	it('carries a max_tokens stop reason on the done frame as length', async () => {
		const frames = [
			'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n',
			'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}\n',
			'data: {"type":"message_stop"}\n'
		];
		const http: HttpRequest = async () => sseResponse(frames);
		const events = await drain(
			anthropicProvider.chatStream({ model: 'claude-x', messages: [], maxTokens: 16 }, conn, http)
		);
		expect(events).toEqual([
			{ type: 'token', text: 'Hi' },
			{ type: 'done', finishReason: 'length' }
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
