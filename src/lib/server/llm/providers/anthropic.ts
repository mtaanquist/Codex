import {
	EndpointReplyError,
	type ChatMessage,
	type CompletionRequest,
	type Connection,
	type FinishReason,
	type HttpResponse,
	type ModelInfo,
	type ProviderToolCall,
	type Provider,
	type StreamEvent,
	type TokenUsage
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

// Anthropic's own web search: the request declares the tool, the search runs on
// their servers, and the answer arrives as ordinary content. Nothing about it
// reaches Codex's tool loop, and the only outbound traffic from this machine is
// still the request to the endpoint.
//
// The dated 2026 tool filters results as it goes and needs a recent model;
// every other model gets the original, which is also the only one Vertex
// carries. A model this pattern does not recognise gets the original too, so a
// name released after this was written fails safe rather than with a 400.
const WEB_SEARCH_FILTERING = /claude-(opus-(5|4-8|4-7|4-6)|sonnet-(5|4-6))/;
// A ceiling on searches per turn, so a canon check cannot run up a bill.
const WEB_SEARCH_MAX_USES = 5;

function webSearchTool(model: string): Record<string, unknown> {
	return {
		type: WEB_SEARCH_FILTERING.test(model) ? 'web_search_20260209' : 'web_search_20250305',
		name: 'web_search',
		max_uses: WEB_SEARCH_MAX_USES
	};
}

function requestBody(req: CompletionRequest, stream: boolean): string {
	const { system, messages } = serialiseMessages(req.messages);
	markLastBlock(messages as { role: string; content: unknown }[]);
	// The writer's own tools and, when the turn asked for it, the server-side
	// search alongside them. A concluding round forbids calls with tool_choice
	// none, which stops the search too: that round is for answering.
	const tools: Record<string, unknown>[] = [
		...(req.tools ?? []).map((tool) => ({
			name: tool.name,
			description: tool.description,
			input_schema: tool.parameters
		})),
		...(req.webSearch ? [webSearchTool(req.model)] : [])
	];
	return JSON.stringify({
		model: req.model,
		max_tokens: req.maxTokens,
		// Thinking on means adaptive; off means omitting the field entirely (an
		// explicit "disabled" is rejected by models where thinking is always on).
		...(req.tuning?.thinking ? { thinking: { type: 'adaptive' } } : {}),
		...(req.tuning?.effort ? { output_config: { effort: req.tuning.effort } } : {}),
		...(system ? { system: [{ type: 'text', text: system, cache_control: CACHE }] } : {}),
		messages,
		...(tools.length
			? {
					tools,
					tool_choice: { type: req.toolChoice === 'none' ? 'none' : 'auto' }
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

// The Messages API reports stop_reason; max_tokens is its name for a reply cut
// off at the token cap.
function parseStopReason(raw: unknown): FinishReason | undefined {
	if (typeof raw !== 'string' || !raw) return undefined;
	if (raw === 'end_turn' || raw === 'stop_sequence') return 'stop';
	if (raw === 'max_tokens') return 'length';
	if (raw === 'tool_use') return 'toolCalls';
	return 'other';
}

function truncate(text: string, max = 300): string {
	const clean = text.replace(/\s+/g, ' ').trim();
	return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

// With caching on, input_tokens is only the uncached remainder; the prompt's
// real size is the sum with the cache reads and writes. The usage log stores
// that sum, and the cache-read share rides alongside it as cachedPromptTokens so
// the cost can price those tokens at the cheaper cache rate.
function cacheRead(usage: { cache_read_input_tokens?: unknown }): number {
	const read = Number(usage.cache_read_input_tokens);
	return Number.isFinite(read) && read > 0 ? read : 0;
}

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
	const cached = cacheRead(usage);
	return {
		promptTokens: prompt,
		completionTokens: completion,
		...(cached > 0 ? { cachedPromptTokens: cached } : {})
	};
}

// The parsed JSON of each "data:" line of a server-sent event stream. Event
// name lines and unparseable data are skipped.
function frameData(line: string): unknown {
	line = line.replace(/\r$/, '');
	if (!line.startsWith('data:')) return undefined;
	const data = line.slice(5).trim();
	if (!data) return undefined;
	try {
		return JSON.parse(data);
	} catch {
		return undefined;
	}
}

async function* sseFrames(body: AsyncIterable<Uint8Array>): AsyncGenerator<unknown> {
	const decoder = new TextDecoder();
	let buffer = '';
	for await (const chunk of body) {
		buffer += decoder.decode(chunk, { stream: true });
		let newline: number;
		while ((newline = buffer.indexOf('\n')) !== -1) {
			const json = frameData(buffer.slice(0, newline));
			buffer = buffer.slice(newline + 1);
			if (json !== undefined) yield json;
		}
	}
	// A last frame the endpoint did not end with a newline.
	const json = frameData(buffer + decoder.decode());
	if (json !== undefined) yield json;
}

// Parse an Anthropic streaming response: "data: {json}" frames whose JSON
// carries a type. Text arrives as content_block_delta/text_delta; the stream
// ends with message_stop. Thinking and tool-input deltas are ignored. Usage
// arrives split across frames: input tokens on message_start, the output
// total on message_delta; the combined count is emitted before done.
async function* parseSse(body: AsyncIterable<Uint8Array>): AsyncGenerator<StreamEvent> {
	let promptTokens: number | undefined;
	let cachedPromptTokens = 0;
	let completionTokens: number | undefined;
	let finishReason: FinishReason | undefined;
	for await (const json of sseFrames(body)) {
		const frame = json as {
			type?: unknown;
			delta?: { type?: unknown; text?: unknown; stop_reason?: unknown };
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
			if (frame.message?.usage) cachedPromptTokens = cacheRead(frame.message.usage);
			continue;
		}
		if (frame.type === 'message_delta') {
			const output = Number(frame.usage?.output_tokens);
			if (Number.isFinite(output)) completionTokens = output;
			finishReason = parseStopReason(frame.delta?.stop_reason) ?? finishReason;
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
					usage: {
						promptTokens: promptTokens ?? 0,
						completionTokens: completionTokens ?? 0,
						...(cachedPromptTokens > 0 ? { cachedPromptTokens } : {})
					}
				};
			}
			yield { type: 'done', ...(finishReason ? { finishReason } : {}) };
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
	// The stream ended without an explicit message_stop; close it out anyway.
	yield { type: 'done', ...(finishReason ? { finishReason } : {}) };
}

type BufferedMessage = { content?: unknown; usage?: unknown; stop_reason?: unknown };

type Block = Record<string, unknown>;

// The status a buffered call gets for the errors Anthropic sends mid-stream.
const STREAM_ERROR_STATUS = new Map<unknown, number>([
	['overloaded_error', 529],
	['api_error', 500]
]);

// Rebuild, from a stream, the message a non-streaming call returns: content
// blocks by index (thinking with its signature, tool_use with its input JSON
// put back together), the stop reason, and usage, whose input side arrives on
// message_start and whose running totals arrive on message_delta. The buffered
// path streams so that a long reply keeps bytes moving and the egress idle
// timeout only fires on real silence.
async function assembleMessage(body: AsyncIterable<Uint8Array>): Promise<BufferedMessage> {
	const blocks: Block[] = [];
	const inputJson = new Map<number, string>();
	let usage: Block = {};
	let stopReason: unknown;
	for await (const json of sseFrames(body)) {
		const frame = json as {
			type?: unknown;
			index?: unknown;
			content_block?: unknown;
			delta?: Block;
			message?: { usage?: Block };
			usage?: Block;
			error?: { type?: unknown; message?: unknown };
		};
		const index = typeof frame.index === 'number' ? frame.index : -1;
		const block = blocks[index];
		const delta = frame.delta;
		switch (frame.type) {
			case 'message_start':
				usage = { ...frame.message?.usage };
				break;
			case 'content_block_start':
				if (index >= 0 && frame.content_block && typeof frame.content_block === 'object') {
					blocks[index] = { ...(frame.content_block as Block) };
				}
				break;
			case 'content_block_delta':
				if (!block || !delta) break;
				if (delta.type === 'text_delta') block.text = `${block.text ?? ''}${delta.text ?? ''}`;
				else if (delta.type === 'thinking_delta') {
					block.thinking = `${block.thinking ?? ''}${delta.thinking ?? ''}`;
				} else if (delta.type === 'signature_delta') {
					block.signature = `${block.signature ?? ''}${delta.signature ?? ''}`;
				} else if (delta.type === 'input_json_delta') {
					inputJson.set(index, `${inputJson.get(index) ?? ''}${delta.partial_json ?? ''}`);
				} else if (delta.type === 'citations_delta') {
					const citations = Array.isArray(block.citations) ? block.citations : [];
					block.citations = [...citations, delta.citation];
				}
				break;
			case 'content_block_stop': {
				const raw = inputJson.get(index);
				// The start frame carries an empty input; the deltas carry the real
				// one, and a call with no arguments sends none. A reply cut off at
				// the token cap can stop mid-argument: parse leniently so the message
				// still assembles and its max_tokens stop reaches the cut-off retry.
				if (block && raw !== undefined) block.input = parseArguments(raw);
				inputJson.delete(index);
				break;
			}
			case 'message_delta':
				if (delta?.stop_reason) stopReason = delta.stop_reason;
				for (const [key, value] of Object.entries(frame.usage ?? {})) {
					if (value !== null && value !== undefined) usage[key] = value;
				}
				break;
			case 'message_stop':
				return { content: blocks.filter(Boolean), usage, stop_reason: stopReason };
			case 'error': {
				const message =
					typeof frame.error?.message === 'string' ? frame.error.message : 'unknown error';
				// Once a stream is open, overload and server faults arrive here
				// instead of as a 529 or 500. Reported as that status, so the gateway
				// retries them as it would the status.
				const status = STREAM_ERROR_STATUS.get(frame.error?.type);
				if (status) throw new Error(`Endpoint returned ${status}: ${message}`);
				throw new EndpointReplyError(`Endpoint stream error: ${message}`);
			}
		}
	}
	// Some Anthropic-compatible endpoints close the body after message_delta
	// without a message_stop. Once the stop reason is in, the reply is whole.
	if (stopReason !== undefined) {
		return { content: blocks.filter(Boolean), usage, stop_reason: stopReason };
	}
	throw new Error('The endpoint closed the stream before the reply finished.');
}

// The reply to a stream: true request. An endpoint that ignores the flag and
// answers in one JSON body is read as one, with or without a JSON content
// type; a broken JSON body throws SyntaxError, which the gateway does not
// retry. Anything else (a captive portal's web page, say) is not a reply.
async function readReply(res: HttpResponse): Promise<BufferedMessage> {
	const type = (res.headers['content-type'] ?? '').toLowerCase();
	if (type.includes('text/event-stream')) return assembleMessage(res.body);
	const text = await res.text();
	if (type.includes('json') || (!type && /^\s*\{/.test(text))) {
		return JSON.parse(text) as BufferedMessage;
	}
	throw new EndpointReplyError(
		`The endpoint answered with ${type || 'an unlabelled body'} instead of a reply: ${truncate(text)}`
	);
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
			body: requestBody(req, true),
			signal
		});
		if (res.status < 200 || res.status >= 300) {
			throw new Error(`Endpoint returned ${res.status}: ${truncate(await res.text())}`);
		}
		const json = await readReply(res);
		const finishReason = parseStopReason(json?.stop_reason);
		return {
			...parseContent(json?.content),
			usage: parseUsage(json?.usage),
			...(finishReason ? { finishReason } : {})
		};
	},

	async listModels(conn, http, signal) {
		// The API pages its list (20 by default); one page of the maximum holds
		// the whole catalogue.
		const res = await http(`${base(conn.endpoint)}/v1/models?limit=1000`, {
			method: 'GET',
			headers: headers(conn),
			signal
		});
		const text = await res.text();
		if (res.status < 200 || res.status >= 300) {
			throw new Error(`Endpoint returned ${res.status}: ${truncate(text)}`);
		}
		const json = JSON.parse(text) as { data?: { id?: unknown; max_input_tokens?: unknown }[] };
		// Each model reports its context window as max_input_tokens.
		const byId = new Map<string, ModelInfo>();
		for (const model of Array.isArray(json.data) ? json.data : []) {
			if (typeof model.id !== 'string' || byId.has(model.id)) continue;
			const tokens = Number(model.max_input_tokens);
			byId.set(
				model.id,
				Number.isFinite(tokens) && tokens > 0
					? { id: model.id, contextLength: Math.floor(tokens) }
					: { id: model.id }
			);
		}
		return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
	}
};
