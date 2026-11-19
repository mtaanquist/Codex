// Provider-neutral request and response shapes for the Assistant gateway. Two
// adapters implement this interface: the OpenAI-compatible one (custom
// endpoints and most hosted providers) and the native Anthropic one, chosen
// from the provider discriminator on the resolved config (see ./index.ts).

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export type ChatMessage = {
	role: ChatRole;
	content: string;
	// An assistant turn that requests tool calls.
	toolCalls?: ProviderToolCall[];
	// A tool-result turn replies to this call id.
	toolCallId?: string;
	// Adapter-private: the provider's own content blocks for an assistant turn,
	// echoed back verbatim on the next request of a tool loop. The Anthropic
	// adapter uses this to preserve thinking blocks, which the API requires
	// unchanged; other adapters ignore it.
	raw?: unknown;
};

// A tool the model may call (function-calling). parameters is a JSON Schema for
// the arguments object.
export type ToolSpec = {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
};

// A tool call the model emitted; arguments is a JSON string, parsed by the
// dispatcher.
export type ProviderToolCall = {
	id: string;
	name: string;
	arguments: string;
};

// Why the model stopped generating, normalised across adapters. 'length' is
// the one the gateway acts on: the reply hit the token cap, so its text and
// any tool-call arguments may be cut off mid-token. Anything an adapter does
// not recognise maps to 'other'; undefined means the endpoint reported none.
// 'refusal' is a reply the model declined to give, and 'paused' a turn the
// endpoint stopped partway (Claude's server-side search loop) that needs one
// more request to finish; neither is a finished reply.
export type FinishReason = 'stop' | 'length' | 'toolCalls' | 'refusal' | 'paused' | 'other';

// A single non-streaming turn: either final content, or a set of tool calls to
// run before the model can continue (or both, though most endpoints pick one).
export type ProviderResponse = {
	content: string;
	toolCalls: ProviderToolCall[];
	// Token counts the endpoint reported for this request, when it did.
	usage?: TokenUsage;
	finishReason?: FinishReason;
	// Adapter-private content blocks to echo back on the next turn; see
	// ChatMessage.raw. Set only when the response carries blocks (thinking)
	// that a reconstructed turn would lose.
	raw?: unknown;
};

export type TokenUsage = {
	// The whole prompt the endpoint billed for, cache reads included.
	promptTokens: number;
	completionTokens: number;
	// The part of promptTokens the endpoint served from its prompt cache, where
	// it reports one. Always a subset of promptTokens, never an extra amount on
	// top: both adapters fold their cache counters into promptTokens and then
	// report the cached share here. Cache reads bill far cheaper than fresh
	// prompt tokens (see spend.ts).
	cachedPromptTokens?: number;
	// Set when a count is the adapter's own estimate rather than the endpoint's
	// report: a stream that failed or was cancelled before the endpoint sent its
	// totals. The usage log marks these rows so they are never read as billed.
	estimated?: boolean;
	// Server-side web searches the endpoint reported running for this request
	// (Claude bills these per search, on top of tokens).
	webSearchRequests?: number;
};

export type CompletionRequest = {
	model: string;
	messages: ChatMessage[];
	// Upper bound on generated tokens; the gateway always sets one so a runaway
	// generation cannot hold a connection open indefinitely.
	maxTokens: number;
	// Tools the model may call this turn; omitted for a plain completion.
	tools?: ToolSpec[];
	// Forbid tool calls for this one round while still declaring the tools. The
	// agent loop sets it on the concluding round: a history holding tool_use and
	// tool_result turns is only valid alongside the tool definitions, so the
	// tools cannot simply be dropped, and keeping them also keeps the cached
	// prompt prefix stable. Unset means the model chooses (the adapters send
	// their "auto" spelling).
	toolChoice?: 'none';
	// Per-role request tuning from the account config. The Anthropic adapter
	// maps thinking to `thinking: {type: "adaptive"}` (omitted when off; an
	// explicit "disabled" is rejected by some models) and effort to
	// `output_config.effort`; the OpenAI-compatible adapter sends temperature,
	// and on thinking === false asks the endpoint to skip the thinking pass.
	// Each adapter ignores the fields it has no use for.
	tuning?: { thinking?: boolean; effort?: string; temperature?: number };
	// Offer the provider's own server-side web search this turn. The Anthropic
	// adapter attaches its web_search tool; other adapters ignore it. The gateway
	// sets it only for an account that opted in, on a universe marked as an
	// established published setting.
	webSearch?: boolean;
	// Extra body fields from the account config, for whatever the writer's server
	// needs that Codex has no field of its own for. The OpenAI-compatible adapter
	// merges them into the request; the Anthropic adapter ignores them. The
	// config layer has already removed anything that would rewrite a field the
	// adapter owns (see RESERVED_PARAM_KEYS in ../config).
	extraParams?: Record<string, unknown>;
};

// A scene-split the Assistant proposed through its tool: where the new scene
// starts (exact text, re-located at confirm time) and why. Rendered as a card
// in the chat transcript; nothing happens until the writer confirms.
export type SplitProposal = {
	sceneId: string;
	sceneTitle: string | null;
	before: string;
	rationale: string;
};

// A token-at-a-time stream the surfaces map straight onto Server-Sent Events.
// Tool-staged proposals ride the same stream as their own frames; clients that
// predate a frame type ignore it.
export type StreamEvent =
	| { type: 'token'; text: string }
	| { type: 'proposal'; proposal: SplitProposal }
	// A tool-using turn had to stop reading before the model was done: the
	// tool-call limit ran out, or the context window filled. The panel shows a
	// note under the reply so a thin answer is not mistaken for a full one.
	| { type: 'stopped'; reason: 'context' | 'budget' }
	// Token counts for the request, when the endpoint reports them mid-stream.
	// The gateway consumes this frame for the usage log; it never reaches a
	// client.
	| { type: 'usage'; usage: TokenUsage }
	// finishReason rides the terminator when the endpoint reported one; clients
	// ignore it, the server side reads it to spot a truncated reply.
	| { type: 'done'; finishReason?: FinishReason }
	| { type: 'error'; message: string };

// Where to reach the endpoint and how to authenticate. The key is decrypted by
// the gateway and never leaves the server.
export type Connection = {
	endpoint: string;
	apiKey: string;
};

// A minimal slice of the fetch/Response contract, over a Node body. The gateway
// supplies the egress-guarded implementation (see ../egress); tests supply a
// stub. Keeping the transport injected is what lets the wire format be tested
// without a network and keeps every outbound call behind the SSRF guard.
export type HttpResponse = {
	status: number;
	headers: Record<string, string>;
	// The raw response body, for streaming reads.
	body: AsyncIterable<Uint8Array>;
	// Buffer the whole body to a string, for non-streaming calls and errors.
	// Consumes the same underlying stream as body, so a caller reads one or the
	// other, never both.
	text(): Promise<string>;
};

// The endpoint answered 2xx, but not with a usable reply: a body that is
// neither the stream nor the JSON asked for (a captive portal's web page), or an
// error event partway through the stream that is not an overload or a server
// fault (those are reported as their status, and retried like it). The gateway
// does not retry it, since a resend gets the same answer, and nothing above it
// does either: the review and summary jobs record the failure and finish, so
// the writer starts the run again.
export class EndpointReplyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'EndpointReplyError';
	}
}

// The abort reason for a stop the writer asked for: Stop on a running job, or
// a browser that cancelled its request. Nothing runs the request again after
// it, so a cut-short reply need not be counted at the output cap. Any other
// abort (a job that expired, a worker shutting down) can be followed by a retry
// that carries the job's spend, so the cap there must hold.
export class WriterStopError extends Error {
	constructor() {
		super('Stopped by the writer.');
		this.name = 'AbortError';
	}
}

export function stoppedByWriter(signal?: AbortSignal): boolean {
	return signal?.aborted === true && signal.reason instanceof WriterStopError;
}

// A signal that aborts as a writer's stop when the given one aborts, for a
// request whose only abort is the browser going away.
export function writerStopSignal(signal: AbortSignal): AbortSignal {
	const controller = new AbortController();
	const stop = () => controller.abort(new WriterStopError());
	if (signal.aborted) stop();
	else signal.addEventListener('abort', stop, { once: true });
	return controller.signal;
}

// A request that failed after the endpoint began generating is still billed
// for the tokens it had used. The adapter attaches that count to the error it
// throws, so the gateway can log and meter it before it retries or gives up.
const BILLED = Symbol('billedUsage');

export function withBilledUsage<E extends Error>(err: E, usage: TokenUsage | undefined): E {
	if (usage) (err as E & { [BILLED]?: TokenUsage })[BILLED] = usage;
	return err;
}

export function billedUsage(err: unknown): TokenUsage | undefined {
	if (!(err instanceof Error)) return undefined;
	return (err as Error & { [BILLED]?: TokenUsage })[BILLED];
}

export type HttpRequestInit = {
	method: string;
	headers: Record<string, string>;
	body?: string;
	signal?: AbortSignal;
};

export type HttpRequest = (url: string, init: HttpRequestInit) => Promise<HttpResponse>;

export interface Provider {
	// Stream a completion as token deltas. Transport errors and non-2xx
	// responses surface as a single { type: 'error' } event rather than throwing,
	// so the streaming endpoint can render them cleanly.
	chatStream(
		req: CompletionRequest,
		conn: Connection,
		http: HttpRequest,
		signal?: AbortSignal
	): AsyncIterable<StreamEvent>;
	// A non-streaming turn that may request tool calls (the agent-loop step).
	// Throws on a transport error or a non-2xx response.
	respond(
		req: CompletionRequest,
		conn: Connection,
		http: HttpRequest,
		signal?: AbortSignal
	): Promise<ProviderResponse>;
	// The endpoint's available models (GET /v1/models), so the writer picks
	// from a list instead of typing a name. Throws on a transport or non-2xx
	// error.
	listModels(conn: Connection, http: HttpRequest, signal?: AbortSignal): Promise<ModelInfo[]>;
}

// A discovered model: the id, plus per-token USD pricing and the context window
// in tokens where the endpoint reports them (OpenRouter does; plain
// OpenAI-style lists do not).
export type ModelInfo = {
	id: string;
	pricing?: { prompt: number; completion: number };
	contextLength?: number;
};
