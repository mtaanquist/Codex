import type {
	ChatMessage,
	CompletionRequest,
	Connection,
	FinishReason,
	ModelInfo,
	ProviderToolCall,
	Provider,
	StreamEvent,
	TokenUsage
} from './types.ts';

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

// Ask the endpoint to skip a reasoning model's thinking pass entirely, rather
// than generating it and having us strip it. There is no standard field for
// this: llama.cpp (and llama-server behind it) forwards chat_template_kwargs
// into the model's chat template, where Qwen3 and the R1 distills read
// enable_thinking. Another server's spelling belongs here, alongside it.
const SUPPRESS_THINKING = { chat_template_kwargs: { enable_thinking: false } };

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
					tool_choice: req.toolChoice === 'none' ? 'none' : 'auto'
				}
			: {}),
		// Sampling temperature for this role, when the account config sets one;
		// otherwise the endpoint's own default applies.
		...(typeof req.tuning?.temperature === 'number' ? { temperature: req.tuning.temperature } : {}),
		...(req.tuning?.thinking === false ? SUPPRESS_THINKING : {}),
		stream,
		// Ask streaming responses to report token usage in a final frame (widely
		// supported and ignored by endpoints that predate it).
		...(stream ? { stream_options: { include_usage: true } } : {})
	});
}

// Both response shapes report usage as prompt_tokens/completion_tokens. Where
// the endpoint also reports prompt_tokens_details.cached_tokens (OpenAI and the
// gateways that mirror it), that count is already part of prompt_tokens; it is
// carried through as the cached share so the cost can price it cheaper.
function parseUsage(raw: unknown): TokenUsage | undefined {
	const usage = raw as
		| {
				prompt_tokens?: unknown;
				completion_tokens?: unknown;
				prompt_tokens_details?: { cached_tokens?: unknown };
		  }
		| undefined;
	const prompt = Number(usage?.prompt_tokens);
	const completion = Number(usage?.completion_tokens);
	if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return undefined;
	const cached = Number(usage?.prompt_tokens_details?.cached_tokens);
	return {
		promptTokens: prompt,
		completionTokens: completion,
		...(Number.isFinite(cached) && cached > 0 ? { cachedPromptTokens: cached } : {})
	};
}

function parseFinishReason(raw: unknown): FinishReason | undefined {
	if (typeof raw !== 'string' || !raw) return undefined;
	if (raw === 'stop') return 'stop';
	if (raw === 'length') return 'length';
	// 'function_call' is the pre-tools spelling some endpoints still send.
	if (raw === 'tool_calls' || raw === 'function_call') return 'toolCalls';
	return 'other';
}

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

// How many trailing characters of text are the start of tag, so a tag split
// across two stream chunks is held back rather than emitted as text.
function partialTagLength(text: string, tag: string): number {
	const most = Math.min(text.length, tag.length - 1);
	for (let length = most; length > 0; length--) {
		if (tag.startsWith(text.slice(text.length - length))) return length;
	}
	return 0;
}

// Drops <think>...</think> blocks, which the local reasoning models (Qwen3,
// the DeepSeek-R1 distills) emit inline in the content. Stateful so the
// streaming path can feed it one delta at a time: text inside a block, and any
// text that might still turn out to be a tag, is held back until it resolves.
// An unclosed block at the end of a stream emits nothing.
function thinkFilter() {
	let held = '';
	let inside = false;
	return {
		push(text: string): string {
			held += text;
			let out = '';
			for (;;) {
				if (inside) {
					const close = held.indexOf(THINK_CLOSE);
					if (close === -1) {
						held = held.slice(held.length - partialTagLength(held, THINK_CLOSE));
						return out;
					}
					held = held.slice(close + THINK_CLOSE.length);
					inside = false;
					continue;
				}
				const open = held.indexOf(THINK_OPEN);
				if (open === -1) {
					const partial = partialTagLength(held, THINK_OPEN);
					out += held.slice(0, held.length - partial);
					held = held.slice(held.length - partial);
					return out;
				}
				out += held.slice(0, open);
				held = held.slice(open + THINK_OPEN.length);
				inside = true;
			}
		},
		// Whatever is still held: a partial open tag that never completed is
		// literal text, an unclosed block is dropped.
		flush(): string {
			const rest = inside ? '' : held;
			held = '';
			inside = false;
			return rest;
		}
	};
}

function stripThinking(text: string): string {
	const filter = thinkFilter();
	return filter.push(text) + filter.flush();
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
// terminated by "data: [DONE]". Content arrives as choices[0].delta.content;
// a reasoning model's separate choices[0].delta.reasoning_content is thinking,
// not answer, so it is never read.
async function* parseSse(body: AsyncIterable<Uint8Array>): AsyncGenerator<StreamEvent> {
	const decoder = new TextDecoder();
	const think = thinkFilter();
	let finishReason: FinishReason | undefined;
	let buffer = '';
	const done = (): StreamEvent => ({
		type: 'done',
		...(finishReason ? { finishReason } : {})
	});
	for await (const chunk of body) {
		buffer += decoder.decode(chunk, { stream: true });
		let newline: number;
		while ((newline = buffer.indexOf('\n')) !== -1) {
			const line = buffer.slice(0, newline).replace(/\r$/, '');
			buffer = buffer.slice(newline + 1);
			if (!line.startsWith('data:')) continue;
			const data = line.slice(5).trim();
			if (data === '[DONE]') {
				const tail = think.flush();
				if (tail) yield { type: 'token', text: tail };
				yield done();
				return;
			}
			if (!data) continue;
			let json: unknown;
			try {
				json = JSON.parse(data);
			} catch {
				continue;
			}
			const choice = (
				json as { choices?: { delta?: { content?: unknown }; finish_reason?: unknown }[] }
			)?.choices?.[0];
			const delta = choice?.delta?.content;
			if (typeof delta === 'string' && delta.length > 0) {
				const text = think.push(delta);
				if (text) yield { type: 'token', text };
			}
			finishReason = parseFinishReason(choice?.finish_reason) ?? finishReason;
			const usage = parseUsage((json as { usage?: unknown })?.usage);
			if (usage) yield { type: 'usage', usage };
		}
	}
	// The stream ended without an explicit [DONE]; close it out anyway.
	const tail = think.flush();
	if (tail) yield { type: 'token', text: tail };
	yield done();
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
			choices?: {
				message?: { content?: unknown; tool_calls?: unknown };
				finish_reason?: unknown;
			}[];
			usage?: unknown;
		};
		const choice = json?.choices?.[0];
		const message = choice?.message ?? {};
		const finishReason = parseFinishReason(choice?.finish_reason);
		return {
			// A reasoning model's thinking arrives either inline in tags or in a
			// separate reasoning_content field; neither belongs in the answer.
			content: typeof message.content === 'string' ? stripThinking(message.content) : '',
			toolCalls: parseToolCalls(message.tool_calls),
			usage: parseUsage(json?.usage),
			...(finishReason ? { finishReason } : {})
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
			data?: {
				id?: unknown;
				pricing?: { prompt?: unknown; completion?: unknown };
				context_length?: unknown;
			}[];
		};
		const items = Array.isArray(json.data) ? json.data : [];
		const byId = new Map<string, ModelInfo>();
		for (const item of items) {
			if (typeof item.id !== 'string' || byId.has(item.id)) continue;
			byId.set(item.id, {
				id: item.id,
				...parsePricing(item.pricing),
				...parseContextLength(item.context_length)
			});
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

// OpenRouter's /models reports the model's context window as context_length;
// most other OpenAI-compatible lists omit it, and a local server reports its
// own launch setting at best, so an absent value stays unset.
function parseContextLength(raw: unknown): Pick<ModelInfo, 'contextLength'> {
	const tokens = Number(raw);
	if (!Number.isFinite(tokens) || tokens <= 0) return {};
	return { contextLength: Math.floor(tokens) };
}
