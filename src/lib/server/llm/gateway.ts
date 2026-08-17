import type { Database } from '../auth.ts';
import { logEvent } from '../log.ts';
import { modelContextWindow, pickModel, resolveLlmConfig, type AssistantRole } from './config.ts';
import { estimateTokens } from './context/assemble.ts';
import { EgressDeniedError, egressHttpRequest, egressPolicy } from './egress.ts';
import { providerFor } from './providers/index.ts';
import { buildPersonaPrompt } from './prompts/persona.ts';
import { recordAssistantUsage } from './usage.ts';
import {
	dispatchToolCall,
	ownedStoryUniverse,
	ownsUniverse,
	type ToolContext,
	type ToolOutcome
} from './tools/dispatch.ts';
import { MINIMAL_TOOL_NAMES, toolSpecs } from './tools/registry.ts';
import type {
	ChatMessage,
	CompletionRequest,
	Connection,
	HttpRequest,
	Provider,
	ProviderResponse,
	StreamEvent,
	TokenUsage,
	ToolSpec
} from './providers/types.ts';

// Adds one request's reported counts to a running total, so a caller can price
// a whole agentic turn. Undefined stays undefined until something is reported.
function addUsage(total: TokenUsage | undefined, next?: TokenUsage): TokenUsage | undefined {
	if (!next) return total;
	return {
		promptTokens: (total?.promptTokens ?? 0) + next.promptTokens,
		completionTokens: (total?.completionTokens ?? 0) + next.completionTokens
	};
}

// The gateway is the one public entry the rest of the app calls. It resolves
// config, enforces the egress policy, picks the model and provider, runs the
// tool loop, and streams or buffers the answer.
//
// The streaming endpoint will call stream(); the worker calls complete() or
// stream() directly with no HTTP hop. Neither path ever exposes the key or the
// endpoint URL to the browser.

export class AssistantDisabledError extends Error {
	constructor(message = 'The Assistant is not enabled for this account.') {
		super(message);
		this.name = 'AssistantDisabledError';
	}
}

// A ceiling so a single generation cannot hold a connection open indefinitely;
// the tool-call budget bounds the agentic loop separately.
const DEFAULT_MAX_TOKENS = 2048;
// A review round emits several tool calls at once, each quoting the passage it
// edits, so it needs more room than a chat turn before it runs into the cap.
const REVIEWER_MAX_TOKENS = 4096;

// The absolute ceiling on tool calls in one run, whatever the request asks
// for; a cross-scene pass over a long story is the case that needs the room.
const REQUEST_TOOL_BUDGET_CEILING = 200;
// The minimal tool profile halves the budget: a weaker model that keeps calling
// tools is usually looping on malformed calls rather than making progress, so
// it is pushed to answer sooner. Never below two, so it can read a scene and
// then act on it.
const MINIMAL_PROFILE_BUDGET_DIVISOR = 2;
const MINIMAL_PROFILE_MIN_BUDGET = 2;

function defaultMaxTokens(role: AssistantRole): number {
	return role === 'reviewer' ? REVIEWER_MAX_TOKENS : DEFAULT_MAX_TOKENS;
}

// Every message costs more on the wire than its text: a role, the framing, and
// for a tool turn its call id. Provisional flat allowance, not measured.
const MESSAGE_OVERHEAD_TOKENS = 8;
// The share of a known context window the agent loop leaves free. The estimate
// is chars/4, which runs short on non-English prose, so the margin absorbs the
// skew as well as whatever the endpoint's own framing adds.
const CONTEXT_SAFETY_MARGIN = 0.15;
// Sent when the context guard fires, so the round that follows knows why its
// tools went away.
const CONTEXT_NUDGE =
	'The context window is nearly full, so no more tools are available. Conclude now with what you already have.';

function messageTokens(message: ChatMessage): number {
	return estimateTokens(message.content) + MESSAGE_OVERHEAD_TOKENS;
}

function conversationTokens(messages: ChatMessage[]): number {
	return messages.reduce((sum, message) => sum + messageTokens(message), 0);
}

export type GatewayRequest = {
	userId: string;
	storyId?: string;
	// The retrieval reach for tools. Given explicitly on the universe surface;
	// derived from storyId's own universe on the story-focused surfaces.
	universeId?: string;
	role: AssistantRole;
	messages: ChatMessage[];
	// Offer the read/write tools this turn. Requires a story context and an
	// endpoint that can call tools; off for plain continuation/co-author turns.
	enableTools?: boolean;
	// Restrict the offered tools to this set (the review-reply turn names the
	// scoped tools here); the default set otherwise.
	toolNames?: string[];
	// Targets for the scoped tools, fixed server-side and never taken from the
	// model's arguments.
	toolScope?: { threadId?: string; suggestionId?: string };
	maxTokens?: number;
	// Raise the tool-call ceiling for this run above the account's budget. A
	// full review needs one call per note plus one read per scene, far beyond
	// the conservative account default; server-set only, never client input.
	toolBudget?: number;
	signal?: AbortSignal;
};

// Test seam: callers may inject a provider and/or transport. Production passes
// neither and gets the configured provider's adapter over the egress-guarded
// transport.
export type GatewayDeps = {
	provider?: Provider;
	http?: HttpRequest;
	// Waits out the backoff between request retries; tests pass a no-op so the
	// suite does not sleep.
	sleep?: (ms: number) => Promise<void>;
};

// A local endpoint reloading a model, or a blip on the way to a hosted one,
// fails one request and is fine on the next. Two short retries cover that
// without keeping a caller waiting when the endpoint is really down.
const RETRY_DELAYS_MS = [250, 1000];

// Transient means "the same request might work in a moment": a thrown
// transport error (socket reset, DNS, connection refused), or a 429/5xx the
// adapters report as `Endpoint returned <status>: ...`. A 4xx other than 429 is
// the request's own fault, an egress denial is policy, and an abort was asked
// for; none of those improve on a second try.
function isTransientFailure(err: unknown): boolean {
	if (err instanceof EgressDeniedError) return false;
	if (!(err instanceof Error)) return false;
	if (err.name === 'AbortError') return false;
	const reported = /^Endpoint returned (\d{3})/.exec(err.message);
	if (reported) {
		const status = Number(reported[1]);
		return status === 429 || (status >= 500 && status < 600);
	}
	return true;
}

// One provider request, retried on a transient failure. This wraps the REQUEST
// only: tool dispatch happens after a response is in hand, so a retry can never
// re-run a write tool.
async function respondWithRetry(
	p: Prepared,
	req: GatewayRequest,
	request: CompletionRequest
): Promise<ProviderResponse> {
	for (let attempt = 0; ; attempt += 1) {
		try {
			return await p.provider.respond(request, p.conn, p.http, req.signal);
		} catch (err) {
			if (attempt >= RETRY_DELAYS_MS.length || req.signal?.aborted || !isTransientFailure(err)) {
				throw err;
			}
			logEvent('warn', 'assistant.retry', {
				userId: req.userId,
				model: p.model,
				attempt: attempt + 1,
				error: err instanceof Error ? err.message : 'request failed'
			});
			await p.sleep(RETRY_DELAYS_MS[attempt]);
		}
	}
}

type Prepared = {
	conn: Connection;
	model: string;
	messages: ChatMessage[];
	http: HttpRequest;
	provider: Provider;
	// Set only when tools are active this turn (enabled, story owned, endpoint
	// capable); the agent loop runs when present.
	tools?: ToolSpec[];
	toolContext?: ToolContext;
	toolBudget: number;
	// Thinking/effort/temperature for this role, from the account config;
	// undefined when the role has none set.
	tuning?: { thinking?: boolean; effort?: string; temperature?: number };
	// The context window of this turn's model, in tokens, where it is known;
	// carried for the callers that size what they send.
	contextWindow?: number;
	sleep: (ms: number) => Promise<void>;
};

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function prepare(db: Database, req: GatewayRequest, deps: GatewayDeps): Promise<Prepared> {
	const resolved = await resolveLlmConfig(db, req.userId, req.storyId);
	// The backstop gate: surfaces check this before calling, but a background
	// caller might not, so refuse here too. surfacesEnabled is account-on and
	// this story not muted.
	if (!resolved.gate.surfacesEnabled) throw new AssistantDisabledError();
	const model = pickModel(resolved.config, req.role);
	if (!model) throw new AssistantDisabledError('No model is configured for this action.');
	const policy = await egressPolicy(db);
	// The persona system message rides at the front of every turn, so the
	// Assistant's name and tone are consistent across surfaces. Any
	// surface-supplied system message (the assembled world context) follows it.
	const persona: ChatMessage = {
		role: 'system',
		content: buildPersonaPrompt(resolved.config.assistantName, resolved.config.persona)
	};

	// The window of the model this role runs on, where one is known; the tools
	// size their results against it and later callers can size what they send.
	const contextWindow = modelContextWindow(resolved.config, req.role);

	// Tools are offered only with a universe context the user owns and an
	// endpoint that can call them; otherwise the turn is a plain completion. The
	// reach is the universe (the cross-story retrieval payoff): given explicitly
	// on the universe surface, or derived from the focus story's own universe on
	// the story-focused surfaces. The supportsTools flag comes from stored config
	// only (a manual opt-out for an endpoint that cannot call tools); nothing
	// probes it automatically.
	let tools: ToolSpec[] | undefined;
	let toolContext: ToolContext | undefined;
	if (req.enableTools && resolved.config.supportsTools !== false) {
		let universeId: string | undefined;
		if (req.universeId) {
			if (await ownsUniverse(db, req.userId, req.universeId)) universeId = req.universeId;
		} else if (req.storyId) {
			universeId = (await ownedStoryUniverse(db, req.userId, req.storyId)) ?? undefined;
		}
		if (universeId) {
			// A surface that names its own tools (the scoped review-reply turn) is
			// left alone; the profile only shapes the default set.
			tools = toolSpecs(
				req.toolNames ??
					(resolved.config.toolProfile === 'minimal' ? MINIMAL_TOOL_NAMES : undefined)
			);
			toolContext = {
				db,
				userId: req.userId,
				universeId,
				storyId: req.storyId,
				scope: req.toolScope,
				allowedTools: tools.map((tool) => tool.name),
				contextWindow
			};
		}
	}

	const budget = Math.min(
		Math.max(req.toolBudget ?? 0, resolved.config.toolCallBudget),
		REQUEST_TOOL_BUDGET_CEILING
	);

	return {
		conn: { endpoint: resolved.config.endpoint, apiKey: resolved.config.apiKey },
		model,
		messages: [persona, ...req.messages],
		http: deps.http ?? egressHttpRequest(policy),
		provider: deps.provider ?? providerFor(resolved.config.provider),
		tools,
		toolContext,
		toolBudget:
			resolved.config.toolProfile === 'minimal'
				? Math.max(MINIMAL_PROFILE_MIN_BUDGET, Math.floor(budget / MINIMAL_PROFILE_BUDGET_DIVISOR))
				: budget,
		tuning: resolved.config.tuning[req.role],
		contextWindow,
		sleep: deps.sleep ?? realSleep
	};
}

// Every provider request logs a usage row (see ./usage), so the account page
// can show what the Assistant has been costing. The endpoint's token report
// rides along when it sent one; the row still lands without it.
function recordUsage(
	db: Database,
	p: Prepared,
	req: GatewayRequest,
	messages: ChatMessage[],
	usage?: { promptTokens: number; completionTokens: number }
): Promise<void> {
	return recordAssistantUsage(db, {
		userId: req.userId,
		storyId: req.storyId,
		role: req.role,
		model: p.model,
		usage,
		// Only worth the pass over the messages when there is a reported count to
		// compare it against (see ./usage).
		estimatedPromptTokens: usage?.promptTokens ? conversationTokens(messages) : undefined
	});
}

// What a tool-using turn produced: the final text, plus any staged actions a
// surface should render alongside it (split proposals and the like).
type AgentResult = {
	content: string;
	surfaces: Extract<StreamEvent, { type: 'proposal' }>[];
	// Review notes the run staged, counted as the tool calls resolve.
	notes: number;
	// The token counts of every request this turn made, summed; the rounds of an
	// agentic turn all land here. Absent when the endpoint reported none.
	usage?: TokenUsage;
	// Why the run had to stop calling tools, when it did: the tool-call budget
	// ran out, or the conversation neared the model's context window. Unset when
	// the model finished on its own.
	stopped?: 'context' | 'budget';
};

// The agent loop: ask the model, run any tool calls it requests (read tools
// fetch, write tools stage), feed the results back, and repeat until it answers
// or the tool-call budget is spent. Once the budget is reached, tools are
// withdrawn so the next turn must answer, bounding the loop. The same happens
// when the conversation nears the model's context window, since every tool
// result appended to it brings the whole run closer to overflowing.
async function runAgent(db: Database, p: Prepared, req: GatewayRequest): Promise<AgentResult> {
	const messages = [...p.messages];
	const surfaces: AgentResult['surfaces'] = [];
	const roundTokens = req.maxTokens ?? defaultMaxTokens(req.role);
	// Room the conversation may take up before tools are withdrawn; unknown
	// window means no guard, which is the behaviour every endpoint had before
	// windows were tracked.
	const usableWindow = p.contextWindow
		? Math.floor(p.contextWindow * (1 - CONTEXT_SAFETY_MARGIN))
		: undefined;
	let estimated = conversationTokens(messages);
	let calls = 0;
	let notes = 0;
	let usage: TokenUsage | undefined;
	let stopped: AgentResult['stopped'];
	const push = (message: ChatMessage) => {
		messages.push(message);
		estimated += messageTokens(message);
	};
	for (;;) {
		const outOfContext = usableWindow !== undefined && estimated + roundTokens > usableWindow;
		const offerTools = p.tools && calls < p.toolBudget && !outOfContext ? p.tools : undefined;
		if (p.tools && !offerTools && !stopped) {
			stopped = outOfContext ? 'context' : 'budget';
			if (outOfContext) {
				logEvent('info', 'assistant.context-guard', {
					userId: req.userId,
					model: p.model,
					estimated,
					window: p.contextWindow
				});
				push({ role: 'user', content: CONTEXT_NUDGE });
			}
		}
		const round = async (maxTokens: number) => {
			const result = await respondWithRetry(p, req, {
				model: p.model,
				messages,
				maxTokens,
				tools: offerTools,
				tuning: p.tuning
			});
			await recordUsage(db, p, req, messages, result.usage);
			usage = addUsage(usage, result.usage);
			return result;
		};
		// A reply cut off at the token cap is unusable: its text stops mid-sentence
		// and its tool-call arguments stop mid-JSON, which either fails to parse or,
		// worse, parses into a plausible but wrong edit. Never act on one - retry
		// the round with more room, and give up loudly if that is still not enough.
		let response = await round(roundTokens);
		if (response.finishReason === 'length') {
			response = await round(roundTokens * 2);
			if (response.finishReason === 'length') {
				throw new Error(
					`The model's reply was cut off at the ${roundTokens * 2} token limit, twice in a row. Nothing was applied. Try a shorter passage, or a model that answers more briefly.`
				);
			}
		}
		if (!offerTools || response.toolCalls.length === 0) {
			return { content: response.content, surfaces, notes, usage, stopped };
		}

		push({
			role: 'assistant',
			content: response.content,
			toolCalls: response.toolCalls,
			raw: response.raw
		});
		for (const call of response.toolCalls) {
			calls += 1;
			const outcome: ToolOutcome =
				calls > p.toolBudget
					? { result: 'Tool-call budget reached; answer with what you have.', staged: false }
					: await dispatchToolCall(p.toolContext!, call);
			if (outcome.note) notes += 1;
			if (outcome.surface) {
				surfaces.push({ type: 'proposal', proposal: outcome.surface.proposal });
			}
			logEvent('info', 'assistant.tool', {
				userId: req.userId,
				tool: call.name,
				staged: outcome.staged
			});
			push({ role: 'tool', content: outcome.result, toolCallId: call.id });
		}
	}
}

export async function* stream(
	db: Database,
	req: GatewayRequest,
	deps: GatewayDeps = {}
): AsyncGenerator<StreamEvent> {
	const prepared = await prepare(db, req, deps);
	logEvent('info', 'assistant.stream', {
		userId: req.userId,
		role: req.role,
		model: prepared.model,
		tools: Boolean(prepared.tools)
	});
	// A tool-using turn resolves its rounds buffered (tool results interleave
	// with generation), then emits the final answer; a plain turn streams live.
	if (prepared.tools) {
		const { content, surfaces } = await runAgent(db, prepared, req);
		if (content) yield { type: 'token', text: content };
		for (const surface of surfaces) yield surface;
		yield { type: 'done' };
		return;
	}
	// The usage frame is the gateway's to log, not the client's to render.
	let usage: { promptTokens: number; completionTokens: number } | undefined;
	for await (const event of prepared.provider.chatStream(
		{
			model: prepared.model,
			messages: prepared.messages,
			maxTokens: req.maxTokens ?? defaultMaxTokens(req.role),
			tuning: prepared.tuning
		},
		prepared.conn,
		prepared.http,
		req.signal
	)) {
		if (event.type === 'usage') {
			usage = event.usage;
			continue;
		}
		yield event;
	}
	await recordUsage(db, prepared, req, prepared.messages, usage);
}

// What a buffered run produced. Most callers want the text only (complete);
// the review runs also need how many notes it staged, which the agent loop
// already sees as the tool calls resolve.
export type CompletionResult = {
	content: string;
	notes: number;
	// Set when the agent loop had to withdraw its tools before the model was
	// done: 'budget' for the tool-call ceiling, 'context' for the window guard.
	stopped?: 'context' | 'budget';
	// Which model answered, and the token counts of every request this run made,
	// summed. Together they let a caller price what the run cost (see spend.ts);
	// usage is absent when the endpoint reported no counts.
	model: string;
	usage?: TokenUsage;
};

export async function complete(
	db: Database,
	req: GatewayRequest,
	deps: GatewayDeps = {}
): Promise<string> {
	return (await completeDetailed(db, req, deps)).content;
}

export async function completeDetailed(
	db: Database,
	req: GatewayRequest,
	deps: GatewayDeps = {}
): Promise<CompletionResult> {
	const prepared = await prepare(db, req, deps);
	logEvent('info', 'assistant.complete', {
		userId: req.userId,
		role: req.role,
		model: prepared.model,
		tools: Boolean(prepared.tools)
	});
	// Buffered callers have no stream to carry staged surfaces; the proposals
	// surface only on the streaming chat path.
	if (prepared.tools) {
		const { content, notes, usage, stopped } = await runAgent(db, prepared, req);
		return { content, notes, usage, stopped, model: prepared.model };
	}
	const response = await respondWithRetry(prepared, req, {
		model: prepared.model,
		messages: prepared.messages,
		maxTokens: req.maxTokens ?? defaultMaxTokens(req.role),
		tuning: prepared.tuning
	});
	await recordUsage(db, prepared, req, prepared.messages, response.usage);
	return { content: response.content, notes: 0, usage: response.usage, model: prepared.model };
}
