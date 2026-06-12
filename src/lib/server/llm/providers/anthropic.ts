import type {
	ChatMessage,
	CompletionRequest,
	Connection,
	ModelInfo,
	ProviderToolCall,
	Provider,
	StreamEvent,
	TokenUsage
} from './types.ts';

// The native Anthropic adapter: speaks the Messages API (/v1/messages), which
// is not OpenAI-compatible. Raw fetch over the injected transport, like the
// OpenAI adapter, so every call stays behind the egress guard and the wire
// format is testable without a network.

const ANTHROPIC_VERSION = '2023-06-01';

// Resolve the base from whatever is stored: a bare host or a base ending in
// /v1. Presets store the bare host.
function base(endpoint: string): string {
	const trimmed = endpoint.replace(/\/+$/, '');
	return trimmed.endsWith('/v1') ? trimmed.slice(0, -'/v1'.length) : trimmed;
}

function headers(conn: Connection): Record<string, string> {
	const h: Record<string, string> = {
		'content-type': 'application/json',
		'anthropic-version': ANTHROPIC_VERSION
	};
	if (conn.apiKey) h['x-api-key'] = conn.apiKey;
	return h;
}

function parseArguments(raw: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

// Map our neutral messages onto the Messages API shape. System messages cannot
// appear in the messages array, so they hoist into the top-level system string;
// tool results become tool_result blocks in user turns, with adjacent tool
// turns merged into one user message (the API requires user/assistant
// alternation, and the agent loop pushes one tool turn per call).
function serialiseMessages(messages: ChatMessage[]): {
	system: string;
	messages: unknown[];
} {
	const system: string[] = [];
	const out: { role: 'user' | 'assistant'; content: unknown }[] = [];
	for (const message of messages) {
		if (message.role === 'system') {
			system.push(message.content);
			continue;
		}
		if (message.role === 'tool') {
			const block = {
				type: 'tool_result',
				tool_use_id: message.toolCallId,
				content: message.content
			};
			const last = out[out.length - 1];
			if (last && last.role === 'user' && Array.isArray(last.content)) {
				last.content.push(block);
			} else {
				out.push({ role: 'user', content: [block] });
			}
			continue;
		}
		// An assistant turn captured with its original content blocks (thinking
		// enabled) echoes back verbatim: the API requires thinking blocks
		// unchanged ahead of the tool_use blocks they precede.
		if (message.role === 'assistant' && Array.isArray(message.raw)) {
			out.push({ role: 'assistant', content: message.raw as unknown[] });
			continue;
		}
		if (message.role === 'assistant' && message.toolCalls?.length) {
			out.push({
				role: 'assistant',
				content: [
					...(message.content ? [{ type: 'text', text: message.content }] : []),
					...message.toolCalls.map((call) => ({
						type: 'tool_use',
						id: call.id,
						name: call.name,
						input: parseArguments(call.arguments)
					}))
				]
			});
			continue;
		}
		out.push({ role: message.role, content: message.content });
	}
	return { system: system.join('\n\n'), messages: out };
}

// Prompt caching. The API caches a prefix up to each cache_control marker:
// one on the system block covers tools + system (persona and world context,
// stable across the turns of a chat and the rounds of a tool loop), and one
// on the last block of the last message lets the next round of a tool loop
// reuse everything sent so far. Reads bill at ~0.1x, writes at ~1.25x, and a
// prompt below the model's cacheable minimum is silently not cached, so the
// markers are safe to send unconditionally.
const CACHE = { type: 'ephemeral' } as const;

function markLastBlock(messages: { role: string; content: unknown }[]): void {
	const last = messages[messages.length - 1];
	// Requests always end on a user turn; never touch an assistant turn, whose
	// blocks may be a replayed thinking sequence the API requires unchanged.
	if (!last || last.role !== 'user') return;
	if (typeof last.content === 'string') {
		last.content = [{ type: 'text', text: last.content, cache_control: CACHE }];
	} else if (Array.isArray(last.content) && last.content.length > 0) {
		const block = last.content[last.content.length - 1];
		if (block && typeof block === 'object') {
			last.content[last.content.length - 1] = { ...block, cache_control: CACHE };
		}
	}
}

function requestBody(req: CompletionRequest, stream: boolean): string {
	const { system, messages } = serialiseMessages(req.messages);
	markLastBlock(messages as { role: string; content: unknown }[]);
	return JSON.stringify({
		model: req.model,
		max_tokens: req.maxTokens,
		// Thinking on means adaptive; off means omitting the field entirely (an
		// explicit "disabled" is rejected by models where thinking is always on).
		...(req.tuning?.thinking ? { thinking: { type: 'adaptive' } } : {}),
		...(req.tuning?.effort ? { output_config: { effort: req.tuning.effort } } : {}),
		...(system ? { system: [{ type: 'text', text: system, cache_control: CACHE }] } : {}),
		messages,
		...(req.tools?.length
			? {
					tools: req.tools.map((tool) => ({
						name: tool.name,
						description: tool.description,
						input_schema: tool.parameters
					})),
					tool_choice: { type: 'auto' }
				}
			: {}),
		stream
	});
}

type ContentBlock = {
	type?: unknown;
	text?: unknown;
	id?: unknown;
	name?: unknown;
	input?: unknown;
};

function parseContent(raw: unknown): {
	content: string;
	toolCalls: ProviderToolCall[];
	raw?: unknown;
} {
	const blocks = Array.isArray(raw) ? (raw as ContentBlock[]) : [];
	const text: string[] = [];
	const toolCalls: ProviderToolCall[] = [];
	// With thinking enabled the response opens with thinking blocks that must
	// be echoed unchanged if this turn re-enters a tool loop; keep the whole
	// block array for that case only.
	const hasThinking = blocks.some(
		(block) => block.type === 'thinking' || block.type === 'redacted_thinking'
	);
	for (const block of blocks) {
		if (block.type === 'text' && typeof block.text === 'string') text.push(block.text);
		if (
			block.type === 'tool_use' &&
			typeof block.id === 'string' &&
			typeof block.name === 'string'
		) {
			toolCalls.push({
				id: block.id,
				name: block.name,
				arguments: JSON.stringify(block.input ?? {})
			});
		}
	}
	return {
		content: text.join(''),
		toolCalls,
		...(hasThinking && toolCalls.length > 0 ? { raw: blocks } : {})
	};
}

function truncate(text: string, max = 300): string {
	const clean = text.replace(/\s+/g, ' ').trim();
	return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

// With caching on, input_tokens is only the uncached remainder; the prompt's
// real size is the sum with the cache reads and writes. The usage log stores
// that sum (cached tokens bill cheaper, so cost estimates err high, which is
// the safe direction for an estimate).
function promptTotal(usage: {
	input_tokens?: unknown;
	cache_creation_input_tokens?: unknown;
	cache_read_input_tokens?: unknown;
}): number {
	const input = Number(usage.input_tokens);
	if (!Number.isFinite(input)) return NaN;
	const creation = Number(usage.cache_creation_input_tokens);
	const read = Number(usage.cache_read_input_tokens);
	return input + (Number.isFinite(creation) ? creation : 0) + (Number.isFinite(read) ? read : 0);
}

function parseUsage(raw: unknown): TokenUsage | undefined {
	const usage = raw as
		| {
				input_tokens?: unknown;
				output_tokens?: unknown;
				cache_creation_input_tokens?: unknown;
				cache_read_input_tokens?: unknown;
		  }
		| undefined;
	if (!usage) return undefined;
	const prompt = promptTotal(usage);
	const completion = Number(usage.output_tokens);
	if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return undefined;
	return { promptTokens: prompt, completionTokens: completion };
}

// Parse an Anthropic streaming response: "data: {json}" frames whose JSON
// carries a type. Text arrives as content_block_delta/text_delta; the stream
// ends with message_stop. Thinking and tool-input deltas are ignored. Usage
// arrives split across frames: input tokens on message_start, the output
// total on message_delta; the combined count is emitted before done.
async function* parseSse(body: AsyncIterable<Uint8Array>): AsyncGenerator<StreamEvent> {
	const decoder = new TextDecoder();
	let buffer = '';
	let promptTokens: number | undefined;
	let completionTokens: number | undefined;
	for await (const chunk of body) {
		buffer += decoder.decode(chunk, { stream: true });
		let newline: number;
		while ((newline = buffer.indexOf('\n')) !== -1) {
			const line = buffer.slice(0, newline).replace(/\r$/, '');
			buffer = buffer.slice(newline + 1);
			if (!line.startsWith('data:')) continue;
			const data = line.slice(5).trim();
			if (!data) continue;
			let json: unknown;
			try {
				json = JSON.parse(data);
			} catch {
				continue;
			}
			const frame = json as {
				type?: unknown;
				delta?: { type?: unknown; text?: unknown };
				message?: {
					usage?: {
						input_tokens?: unknown;
						cache_creation_input_tokens?: unknown;
						cache_read_input_tokens?: unknown;
					};
				};
				usage?: { output_tokens?: unknown };
				error?: { message?: unknown };
			};
			if (frame.type === 'message_start') {
				const input = frame.message?.usage ? promptTotal(frame.message.usage) : NaN;
				if (Number.isFinite(input)) promptTokens = input;
				continue;
			}
			if (frame.type === 'message_delta') {
				const output = Number(frame.usage?.output_tokens);
				if (Number.isFinite(output)) completionTokens = output;
				continue;
			}
			if (frame.type === 'content_block_delta' && frame.delta?.type === 'text_delta') {
				if (typeof frame.delta.text === 'string' && frame.delta.text.length > 0) {
					yield { type: 'token', text: frame.delta.text };
				}
				continue;
			}
			if (frame.type === 'message_stop') {
				if (promptTokens !== undefined || completionTokens !== undefined) {
					yield {
						type: 'usage',
						usage: { promptTokens: promptTokens ?? 0, completionTokens: completionTokens ?? 0 }
					};
				}
				yield { type: 'done' };
				return;
			}
			if (frame.type === 'error') {
				yield {
					type: 'error',
					message: typeof frame.error?.message === 'string' ? frame.error.message : 'stream error'
				};
				return;
			}
		}
	}
	// The stream ended without an explicit message_stop; close it out anyway.
	yield { type: 'done' };
}

export const anthropicProvider: Provider = {
	async *chatStream(req, conn, http, signal) {
		let res;
		try {
			res = await http(`${base(conn.endpoint)}/v1/messages`, {
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
		const res = await http(`${base(conn.endpoint)}/v1/messages`, {
			method: 'POST',
			headers: headers(conn),
			body: requestBody(req, false),
			signal
		});
		const text = await res.text();
		if (res.status < 200 || res.status >= 300) {
			throw new Error(`Endpoint returned ${res.status}: ${truncate(text)}`);
		}
		const json = JSON.parse(text) as { content?: unknown; usage?: unknown };
		return { ...parseContent(json?.content), usage: parseUsage(json?.usage) };
	},

	async listModels(conn, http, signal) {
		const res = await http(`${base(conn.endpoint)}/v1/models`, {
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
		return [...new Set(ids)].sort((a, b) => a.localeCompare(b)).map((id): ModelInfo => ({ id }));
	}
};
