import type {
	ChatMessage,
	CompletionRequest,
	Connection,
	ModelInfo,
	ProviderToolCall,
	Provider,
	StreamEvent,
	TokenUsage
} from './types';

// The OpenAI-compatible adapter. It speaks /v1/chat/completions, the de-facto
// shape Ollama, vLLM, and most hosted APIs (OpenAI, DeepSeek, OpenRouter,
// Gemini's compatibility layer) expose. The native Anthropic adapter lives in
// ./anthropic.ts behind the same Provider interface.

// Resolve the versioned base from whatever the writer entered: a bare host, a
// base ending in /v1 (or Gemini's /openai compatibility path), or a full
// completions URL.
function baseV1(endpoint: string): string {
	const trimmed = endpoint.replace(/\/+$/, '');
	if (trimmed.endsWith('/chat/completions')) {
		return trimmed.slice(0, trimmed.length - '/chat/completions'.length);
	}
	if (trimmed.endsWith('/v1') || trimmed.endsWith('/openai')) return trimmed;
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
		stream,
		// Ask streaming responses to report token usage in a final frame (widely
		// supported and ignored by endpoints that predate it).
		...(stream ? { stream_options: { include_usage: true } } : {})
	});
}

// Both response shapes report usage as prompt_tokens/completion_tokens.
function parseUsage(raw: unknown): TokenUsage | undefined {
	const usage = raw as { prompt_tokens?: unknown; completion_tokens?: unknown } | undefined;
	const prompt = Number(usage?.prompt_tokens);
	const completion = Number(usage?.completion_tokens);
	if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return undefined;
	return { promptTokens: prompt, completionTokens: completion };
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
			const usage = parseUsage((json as { usage?: unknown })?.usage);
			if (usage) yield { type: 'usage', usage };
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
			usage?: unknown;
		};
		const message = json?.choices?.[0]?.message ?? {};
		return {
			content: typeof message.content === 'string' ? message.content : '',
			toolCalls: parseToolCalls(message.tool_calls),
			usage: parseUsage(json?.usage)
		};
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
		const json = JSON.parse(text) as {
			data?: { id?: unknown; pricing?: { prompt?: unknown; completion?: unknown } }[];
		};
		const items = Array.isArray(json.data) ? json.data : [];
		const byId = new Map<string, ModelInfo>();
		for (const item of items) {
			if (typeof item.id !== 'string' || byId.has(item.id)) continue;
			byId.set(item.id, { id: item.id, ...parsePricing(item.pricing) });
		}
		return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
	}
};

// OpenRouter's /models reports per-token USD pricing as strings; carry it
// through where present so the picker can show it. Other endpoints omit it.
function parsePricing(
	raw:
		| {
				prompt?: unknown;
				completion?: unknown;
		  }
		| undefined
): Pick<ModelInfo, 'pricing'> {
	const prompt = Number(raw?.prompt);
	const completion = Number(raw?.completion);
	if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return {};
	if (prompt === 0 && completion === 0) return {};
	return { pricing: { prompt, completion } };
}
