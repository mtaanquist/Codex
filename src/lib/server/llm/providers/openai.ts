import type {
	ChatMessage,
	CompletionRequest,
	Connection,
	HttpRequest,
	ProviderToolCall,
	Provider,
	StreamEvent
} from './types';

// The OpenAI-compatible adapter: the only provider in the first cut. It speaks
// /v1/chat/completions, the de-facto shape Ollama, vLLM, hosted APIs, and
// Anthropic's compatibility endpoint all expose. A native Claude adapter slots
// behind the same Provider interface later.

// Resolve the `/v1` base from whatever the writer entered: a bare host, a base
// ending in /v1, or a full completions URL.
function baseV1(endpoint: string): string {
	const trimmed = endpoint.replace(/\/+$/, '');
	if (trimmed.endsWith('/chat/completions')) {
		return trimmed.slice(0, trimmed.length - '/chat/completions'.length);
	}
	if (trimmed.endsWith('/v1')) return trimmed;
	return `${trimmed}/v1`;
}

function endpointUrl(endpoint: string): string {
	return `${baseV1(endpoint)}/chat/completions`;
}

function modelsUrl(endpoint: string): string {
	return `${baseV1(endpoint)}/models`;
}

function headers(conn: Connection): Record<string, string> {
	const h: Record<string, string> = { 'content-type': 'application/json' };
	// Local endpoints (Ollama) need no key; only send one when set.
	if (conn.apiKey) h['authorization'] = `Bearer ${conn.apiKey}`;
	return h;
}

// Map our neutral messages onto the OpenAI wire shape, carrying assistant
// tool-call turns and tool-result turns through unchanged.
function serialiseMessages(messages: ChatMessage[]): unknown[] {
	return messages.map((message) => {
		if (message.role === 'tool') {
			return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
		}
		if (message.role === 'assistant' && message.toolCalls?.length) {
			return {
				role: 'assistant',
				content: message.content || null,
				tool_calls: message.toolCalls.map((call) => ({
					id: call.id,
					type: 'function',
					function: { name: call.name, arguments: call.arguments }
				}))
			};
		}
		return { role: message.role, content: message.content };
	});
}

function requestBody(req: CompletionRequest, stream: boolean): string {
	return JSON.stringify({
		model: req.model,
		messages: serialiseMessages(req.messages),
		max_tokens: req.maxTokens,
		...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
		...(req.tools?.length
			? {
					tools: req.tools.map((tool) => ({
						type: 'function',
						function: {
							name: tool.name,
							description: tool.description,
							parameters: tool.parameters
						}
					})),
					tool_choice: 'auto'
				}
			: {}),
		stream
	});
}

function parseToolCalls(raw: unknown): ProviderToolCall[] {
	if (!Array.isArray(raw)) return [];
	const calls: ProviderToolCall[] = [];
	for (const item of raw) {
		const fn = (item as { id?: unknown; function?: { name?: unknown; arguments?: unknown } })
			?.function;
		const id = (item as { id?: unknown }).id;
		if (typeof id === 'string' && typeof fn?.name === 'string') {
			calls.push({
				id,
				name: fn.name,
				arguments: typeof fn.arguments === 'string' ? fn.arguments : '{}'
			});
		}
	}
	return calls;
}

// Probe whether the endpoint and model can call tools: offer one trivial no-arg
// tool and a prompt that should trigger it, and see whether a tool call comes
// back. A best-effort heuristic - any error or a plain text answer reads as "no
// tools" - so the setup screen can show tool support without a false promise.
async function detectTools(
	conn: Connection,
	model: string,
	http: HttpRequest,
	signal?: AbortSignal
): Promise<boolean> {
	try {
		const res = await http(endpointUrl(conn.endpoint), {
			method: 'POST',
			headers: headers(conn),
			body: JSON.stringify({
				model,
				messages: [{ role: 'user', content: 'Call the ping tool to confirm tools work.' }],
				max_tokens: 16,
				tools: [
					{
						type: 'function',
						function: {
							name: 'ping',
							description: 'A connectivity probe; call it with no arguments.',
							parameters: { type: 'object', properties: {}, additionalProperties: false }
						}
					}
				],
				tool_choice: 'auto',
				stream: false
			}),
			signal
		});
		if (res.status < 200 || res.status >= 300) {
			await res.text().catch(() => '');
			return false;
		}
		const json = JSON.parse(await res.text()) as {
			choices?: { message?: { tool_calls?: unknown } }[];
		};
		return parseToolCalls(json?.choices?.[0]?.message?.tool_calls).length > 0;
	} catch {
		return false;
	}
}

function truncate(text: string, max = 300): string {
	const clean = text.replace(/\s+/g, ' ').trim();
	return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

// Parse an OpenAI streaming response: newline-delimited "data: {json}" frames,
// terminated by "data: [DONE]". Content arrives as choices[0].delta.content.
async function* parseSse(body: AsyncIterable<Uint8Array>): AsyncGenerator<StreamEvent> {
	const decoder = new TextDecoder();
	let buffer = '';
	for await (const chunk of body) {
		buffer += decoder.decode(chunk, { stream: true });
		let newline: number;
		while ((newline = buffer.indexOf('\n')) !== -1) {
			const line = buffer.slice(0, newline).replace(/\r$/, '');
			buffer = buffer.slice(newline + 1);
			if (!line.startsWith('data:')) continue;
			const data = line.slice(5).trim();
			if (data === '[DONE]') {
				yield { type: 'done' };
				return;
			}
			if (!data) continue;
			let json: unknown;
			try {
				json = JSON.parse(data);
			} catch {
				continue;
			}
			const delta = (json as { choices?: { delta?: { content?: unknown } }[] })?.choices?.[0]?.delta
				?.content;
			if (typeof delta === 'string' && delta.length > 0) {
				yield { type: 'token', text: delta };
			}
		}
	}
	// The stream ended without an explicit [DONE]; close it out anyway.
	yield { type: 'done' };
}

export const openaiProvider: Provider = {
	async *chatStream(req, conn, http, signal) {
		let res;
		try {
			res = await http(endpointUrl(conn.endpoint), {
				method: 'POST',
				headers: headers(conn),
				body: requestBody(req, true),
				signal
			});
		} catch (err) {
			yield { type: 'error', message: err instanceof Error ? err.message : 'request failed' };
			return;
		}
		if (res.status < 200 || res.status >= 300) {
			yield {
				type: 'error',
				message: `Endpoint returned ${res.status}: ${truncate(await res.text())}`
			};
			return;
		}
		yield* parseSse(res.body);
	},

	async respond(req, conn, http, signal) {
		const res = await http(endpointUrl(conn.endpoint), {
			method: 'POST',
			headers: headers(conn),
			body: requestBody(req, false),
			signal
		});
		const text = await res.text();
		if (res.status < 200 || res.status >= 300) {
			throw new Error(`Endpoint returned ${res.status}: ${truncate(text)}`);
		}
		const json = JSON.parse(text) as {
			choices?: { message?: { content?: unknown; tool_calls?: unknown } }[];
		};
		const message = json?.choices?.[0]?.message ?? {};
		return {
			content: typeof message.content === 'string' ? message.content : '',
			toolCalls: parseToolCalls(message.tool_calls)
		};
	},

	async probe(conn, model, http, signal) {
		let res;
		try {
			res = await http(endpointUrl(conn.endpoint), {
				method: 'POST',
				headers: headers(conn),
				body: JSON.stringify({
					model,
					messages: [{ role: 'user', content: 'ping' }],
					max_tokens: 1,
					stream: true
				}),
				signal
			});
		} catch (err) {
			return { ok: false, reason: err instanceof Error ? err.message : 'request failed' };
		}
		if (res.status < 200 || res.status >= 300) {
			return {
				ok: false,
				reason: `Endpoint returned ${res.status}: ${truncate(await res.text())}`
			};
		}
		// An endpoint that honours stream:true answers as text/event-stream;
		// one that ignores it returns buffered JSON.
		const supportsStreaming = (res.headers['content-type'] ?? '').includes('text/event-stream');
		try {
			for await (const _chunk of res.body) {
				void _chunk;
			}
		} catch {
			// Draining is best-effort; the probe already succeeded.
		}
		const supportsTools = await detectTools(conn, model, http, signal);
		return { ok: true, supportsStreaming, supportsTools };
	},

	async listModels(conn, http, signal) {
		const res = await http(modelsUrl(conn.endpoint), {
			method: 'GET',
			headers: headers(conn),
			signal
		});
		const text = await res.text();
		if (res.status < 200 || res.status >= 300) {
			throw new Error(`Endpoint returned ${res.status}: ${truncate(text)}`);
		}
		const json = JSON.parse(text) as { data?: { id?: unknown }[] };
		const ids = Array.isArray(json.data)
			? json.data.map((m) => m.id).filter((id): id is string => typeof id === 'string')
			: [];
		return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
	}
};
