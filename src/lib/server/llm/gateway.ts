import type { Database } from '../auth';
import { logEvent } from '../log';
import { resolveLlmConfig, type AssistantRole, type ResolvedConfig } from './config';
import { egressHttpRequest, egressPolicy } from './egress';
import { openaiProvider } from './providers/openai';
import { buildPersonaPrompt } from './prompts/persona';
import type { ChatMessage, HttpRequest, Provider } from './providers/types';

// The gateway is the one public entry the rest of the app calls. It resolves
// config, enforces the egress policy, picks the model and provider, and
// streams or buffers a completion. Context assembly and the tool loop are
// later seams (see assistant.md sequencing); this first cut wires config ->
// egress -> provider and leaves those steps for their own surfaces.
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

// A ceiling so a single completion cannot hold a connection open indefinitely.
// The per-turn tool-call budget (a later surface) bounds agentic loops; this
// bounds one generation.
const DEFAULT_MAX_TOKENS = 2048;

export type GatewayRequest = {
	userId: string;
	storyId?: string;
	role: AssistantRole;
	messages: ChatMessage[];
	maxTokens?: number;
	temperature?: number;
	signal?: AbortSignal;
};

// Test seam: callers may inject a provider and/or transport. Production passes
// neither and gets the OpenAI adapter over the egress-guarded transport.
export type GatewayDeps = {
	provider?: Provider;
	http?: HttpRequest;
};

function pickModel(config: ResolvedConfig, role: AssistantRole): string {
	return config.models[role] || config.models.chat || Object.values(config.models)[0] || '';
}

function selectProvider(): Provider {
	// One provider today. The seam for a native Claude adapter, chosen from a
	// provider discriminator on the resolved config, lands later.
	return openaiProvider;
}

type Prepared = {
	config: ResolvedConfig;
	model: string;
	messages: ChatMessage[];
	http: HttpRequest;
	provider: Provider;
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
	// Assistant's name and tone are consistent across surfaces without each one
	// remembering to set them. Any surface-supplied system message (the assembled
	// world context) follows it.
	const persona: ChatMessage = {
		role: 'system',
		content: buildPersonaPrompt(resolved.config.assistantName, resolved.config.persona)
	};
	return {
		config: resolved.config,
		model,
		messages: [persona, ...req.messages],
		http: deps.http ?? egressHttpRequest(policy),
		provider: deps.provider ?? selectProvider()
	};
}

export async function* stream(
	db: Database,
	req: GatewayRequest,
	deps: GatewayDeps = {}
): AsyncGenerator<import('./providers/types').StreamEvent> {
	const { config, model, messages, http, provider } = await prepare(db, req, deps);
	logEvent('info', 'assistant.stream', { userId: req.userId, role: req.role, model });
	yield* provider.chatStream(
		{
			model,
			messages,
			maxTokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
			temperature: req.temperature
		},
		{ endpoint: config.endpoint, apiKey: config.apiKey },
		http,
		req.signal
	);
}

export async function complete(
	db: Database,
	req: GatewayRequest,
	deps: GatewayDeps = {}
): Promise<string> {
	const { config, model, messages, http, provider } = await prepare(db, req, deps);
	logEvent('info', 'assistant.complete', { userId: req.userId, role: req.role, model });
	return provider.complete(
		{
			model,
			messages,
			maxTokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
			temperature: req.temperature
		},
		{ endpoint: config.endpoint, apiKey: config.apiKey },
		http,
		req.signal
	);
}
