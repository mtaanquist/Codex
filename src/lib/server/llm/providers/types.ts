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

// A single non-streaming turn: either final content, or a set of tool calls to
// run before the model can continue (or both, though most endpoints pick one).
export type ProviderResponse = {
	content: string;
	toolCalls: ProviderToolCall[];
	// Token counts the endpoint reported for this request, when it did.
	usage?: TokenUsage;
	// Adapter-private content blocks to echo back on the next turn; see
	// ChatMessage.raw. Set only when the response carries blocks (thinking)
	// that a reconstructed turn would lose.
	raw?: unknown;
};

export type TokenUsage = {
	promptTokens: number;
	completionTokens: number;
};

export type CompletionRequest = {
	model: string;
	messages: ChatMessage[];
	// Upper bound on generated tokens; the gateway always sets one so a runaway
	// generation cannot hold a connection open indefinitely.
	maxTokens: number;
	// Tools the model may call this turn; omitted for a plain completion.
	tools?: ToolSpec[];
	// Per-role request tuning from the account config. The Anthropic adapter
	// maps thinking to `thinking: {type: "adaptive"}` (omitted when off; an
	// explicit "disabled" is rejected by some models) and effort to
	// `output_config.effort`. Other adapters ignore it.
	tuning?: { thinking?: boolean; effort?: string };
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
	// Token counts for the request, when the endpoint reports them mid-stream.
	// The gateway consumes this frame for the usage log; it never reaches a
	// client.
	| { type: 'usage'; usage: TokenUsage }
	| { type: 'done' }
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

// A discovered model: the id, plus per-token USD pricing where the endpoint
// reports it (OpenRouter does; plain OpenAI-style lists do not).
export type ModelInfo = {
	id: string;
	pricing?: { prompt: number; completion: number };
};
