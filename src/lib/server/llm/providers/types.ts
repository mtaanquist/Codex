// Provider-neutral request and response shapes for the Assistant gateway. The
// OpenAI-compatible adapter is the only implementation in the first cut; a
// native Claude adapter slots behind the same interface later, chosen from the
// resolved config without reworking the surfaces.

export type ChatRole = 'system' | 'user' | 'assistant';

export type ChatMessage = {
	role: ChatRole;
	content: string;
};

export type CompletionRequest = {
	model: string;
	messages: ChatMessage[];
	// Upper bound on generated tokens; the gateway always sets one so a runaway
	// generation cannot hold a connection open indefinitely.
	maxTokens: number;
	// Sampling temperature, left to the provider default when unset.
	temperature?: number;
};

// A token-at-a-time stream the surfaces map straight onto Server-Sent Events.
export type StreamEvent =
	| { type: 'token'; text: string }
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

export type ProbeResult =
	| { ok: true; supportsStreaming: boolean; supportsTools: boolean }
	| { ok: false; reason: string };

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
	// Buffer a non-streaming completion to its full text. Throws on a transport
	// error or a non-2xx response.
	complete(
		req: CompletionRequest,
		conn: Connection,
		http: HttpRequest,
		signal?: AbortSignal
	): Promise<string>;
	// The "test connection" probe: a trivial completion that reports reachability
	// and the endpoint's detected capabilities.
	probe(
		conn: Connection,
		model: string,
		http: HttpRequest,
		signal?: AbortSignal
	): Promise<ProbeResult>;
}
