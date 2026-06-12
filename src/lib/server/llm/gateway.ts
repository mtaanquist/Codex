import type { Database } from '../auth.ts';
import { logEvent } from '../log.ts';
import { resolveLlmConfig, type AssistantRole, type ResolvedConfig } from './config.ts';
import { egressHttpRequest, egressPolicy } from './egress.ts';
import { providerFor } from './providers/index.ts';
import { buildPersonaPrompt } from './prompts/persona.ts';
import { recordAssistantUsage } from './usage.ts';
import { dispatchToolCall, ownsStory, type ToolContext } from './tools/dispatch.ts';
import { toolSpecs } from './tools/registry.ts';
import type {
	ChatMessage,
	Connection,
	HttpRequest,
	Provider,
	StreamEvent,
	ToolSpec
} from './providers/types.ts';

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

export type GatewayRequest = {
	userId: string;
	storyId?: string;
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
	signal?: AbortSignal;
};

// Test seam: callers may inject a provider and/or transport. Production passes
// neither and gets the configured provider's adapter over the egress-guarded
// transport.
export type GatewayDeps = {
	provider?: Provider;
	http?: HttpRequest;
};

export function pickModel(config: ResolvedConfig, role: AssistantRole): string {
	return config.models[role] || config.models.chat || Object.values(config.models)[0] || '';
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
};

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

	// Tools are offered only with a story context the user owns and an endpoint
	// that can call them; otherwise the turn is a plain completion. The
	// supportsTools flag comes from stored config only (a manual opt-out for
	// an endpoint that cannot call tools); nothing probes it automatically.
	let tools: ToolSpec[] | undefined;
	let toolContext: ToolContext | undefined;
	if (
		req.enableTools &&
		req.storyId &&
		resolved.config.supportsTools !== false &&
		(await ownsStory(db, req.userId, req.storyId))
	) {
		tools = toolSpecs(req.toolNames);
		toolContext = {
			db,
			userId: req.userId,
			storyId: req.storyId,
			scope: req.toolScope,
			allowedTools: tools.map((tool) => tool.name)
		};
	}

	return {
		conn: { endpoint: resolved.config.endpoint, apiKey: resolved.config.apiKey },
		model,
		messages: [persona, ...req.messages],
		http: deps.http ?? egressHttpRequest(policy),
		provider: deps.provider ?? providerFor(resolved.config.provider),
		tools,
		toolContext,
		toolBudget: resolved.config.toolCallBudget
	};
}

// Every provider request logs a usage row (see ./usage), so the account page
// can show what the Assistant has been costing. The endpoint's token report
// rides along when it sent one; the row still lands without it.
function recordUsage(
	db: Database,
	p: Prepared,
	req: GatewayRequest,
	usage?: { promptTokens: number; completionTokens: number }
): Promise<void> {
	return recordAssistantUsage(db, {
		userId: req.userId,
		storyId: req.storyId,
		role: req.role,
		model: p.model,
		usage
	});
}

// What a tool-using turn produced: the final text, plus any staged actions a
// surface should render alongside it (split proposals and the like).
type AgentResult = {
	content: string;
	surfaces: Extract<StreamEvent, { type: 'proposal' }>[];
};

// The agent loop: ask the model, run any tool calls it requests (read tools
// fetch, write tools stage), feed the results back, and repeat until it answers
// or the tool-call budget is spent. Once the budget is reached, tools are
// withdrawn so the next turn must answer, bounding the loop.
async function runAgent(db: Database, p: Prepared, req: GatewayRequest): Promise<AgentResult> {
	const messages = [...p.messages];
	const surfaces: AgentResult['surfaces'] = [];
	let calls = 0;
	for (;;) {
		const offerTools = p.tools && calls < p.toolBudget ? p.tools : undefined;
		const response = await p.provider.respond(
			{
				model: p.model,
				messages,
				maxTokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
				tools: offerTools
			},
			p.conn,
			p.http,
			req.signal
		);
		await recordUsage(db, p, req, response.usage);
		if (!offerTools || response.toolCalls.length === 0) {
			return { content: response.content, surfaces };
		}

		messages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls });
		for (const call of response.toolCalls) {
			calls += 1;
			const outcome =
				calls > p.toolBudget
					? { result: 'Tool-call budget reached; answer with what you have.', staged: false }
					: await dispatchToolCall(p.toolContext!, call);
			if ('surface' in outcome && outcome.surface) {
				surfaces.push({ type: 'proposal', proposal: outcome.surface.proposal });
			}
			logEvent('info', 'assistant.tool', {
				userId: req.userId,
				tool: call.name,
				staged: outcome.staged
			});
			messages.push({ role: 'tool', content: outcome.result, toolCallId: call.id });
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
			maxTokens: req.maxTokens ?? DEFAULT_MAX_TOKENS
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
	await recordUsage(db, prepared, req, usage);
}

export async function complete(
	db: Database,
	req: GatewayRequest,
	deps: GatewayDeps = {}
): Promise<string> {
	const prepared = await prepare(db, req, deps);
	logEvent('info', 'assistant.complete', {
		userId: req.userId,
		role: req.role,
		model: prepared.model,
		tools: Boolean(prepared.tools)
	});
	// Buffered callers have no stream to carry staged surfaces; the proposals
	// surface only on the streaming chat path.
	if (prepared.tools) return (await runAgent(db, prepared, req)).content;
	const response = await prepared.provider.respond(
		{
			model: prepared.model,
			messages: prepared.messages,
			maxTokens: req.maxTokens ?? DEFAULT_MAX_TOKENS
		},
		prepared.conn,
		prepared.http,
		req.signal
	);
	await recordUsage(db, prepared, req, response.usage);
	return response.content;
}
