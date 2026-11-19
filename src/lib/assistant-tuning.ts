// The Assistant's role names and the bounds on each per-role tuning value.
// Both the server config and the account settings page need to agree on these,
// and the settings page cannot import #lib/server, so they live here instead of
// being spelled once on each side. #lib/server/llm/config re-exports the roles
// and effort levels, so server callers keep one import.

// 'utility' covers the background work the writer never prompts directly:
// summary maintenance, entity extraction, and the recap.
export const ASSISTANT_ROLES = ['continuation', 'coauthor', 'reviewer', 'utility', 'chat'] as const;
export type AssistantRole = (typeof ASSISTANT_ROLES)[number];

// The Claude provider's own effort levels; every other endpoint ignores them.
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

// Extra fields merged into the request body the OpenAI-compatible adapter
// sends, exactly as the writer typed them. Every server spells its own
// switches differently, and hardcoding those dialects is a losing game: this
// is the escape hatch instead. Stored config only, never client input at
// request time.
export type ExtraParams = Record<string, unknown>;

// Per-role request tuning: whether to ask for adaptive thinking and an effort
// level (the Anthropic adapter), a sampling temperature and extra request
// fields (the OpenAI-compatible adapter), and the longest reply the role may
// ask for (both). All optional; absent means the provider's defaults, and each
// adapter ignores the fields it has no use for.
//
// thinking has three states, and both explicit ones are stored: true asks
// Anthropic for adaptive thinking, false asks an OpenAI-compatible endpoint to
// suppress a reasoning model's thinking pass (the Anthropic adapter treats
// false the same as absent), and absent leaves the endpoint's default alone.
export type RoleTuning = {
	thinking?: boolean;
	effort?: EffortLevel;
	temperature?: number;
	maxTokens?: number;
	extraParams?: ExtraParams;
};
export type TuningMap = Partial<Record<AssistantRole, RoleTuning>>;

// Temperature runs 0 to 2 on an OpenAI-compatible endpoint. The step is what
// the settings slider moves by: a tenth is too coarse to land on the values
// writers actually want (0.85, 0.95).
export const MAX_TEMPERATURE = 2;
export const TEMPERATURE_STEP = 0.05;

// A ceiling on the reply length a writer may ask for, well above any model's
// output limit; it only stops a typo from asking for millions of tokens.
export const MAX_REPLY_TOKENS = 65_536;

// What Codex asks for when a role has no reply length of its own: a ceiling so
// a single generation cannot hold a connection open indefinitely.
const DEFAULT_MAX_TOKENS = 2048;
// A review round emits several tool calls at once, each quoting the passage it
// edits, so it needs more room than a chat turn before it runs into the cap.
const REVIEWER_MAX_TOKENS = 4096;
// Thinking counts toward the reply length, and at high effort it can spend a
// few thousand tokens before the answer starts, so a role that may think gets
// far more room. Where the model's context window is known the extra room is
// held to a quarter of it, so a small local window is not spent on the reply
// before the prompt is in.
const THINKING_MAX_TOKENS = 16_384;
const THINKING_WINDOW_SHARE = 4;

// Whether a role's requests may think: Claude models think on their own unless
// told otherwise (Off on the Claude provider changes nothing), and elsewhere
// only when Thinking is On. Setting an effort level implies it too.
export function roleMayThink(anthropic: boolean, tuning: RoleTuning | undefined): boolean {
	return anthropic || tuning?.thinking === true || tuning?.effort !== undefined;
}

export function defaultMaxTokens(
	role: AssistantRole,
	thinks = false,
	contextWindow?: number
): number {
	const base = role === 'reviewer' ? REVIEWER_MAX_TOKENS : DEFAULT_MAX_TOKENS;
	if (!thinks) return base;
	const room = contextWindow
		? Math.min(THINKING_MAX_TOKENS, Math.floor(contextWindow / THINKING_WINDOW_SHARE))
		: THINKING_MAX_TOKENS;
	return Math.max(base, room);
}

// The effort Codex asks Claude for when a role sets none. Current Claude models
// cannot turn thinking off, so effort is the lever: low keeps inline
// suggestions and background work quick and cheap, the conversational roles sit
// in the middle, and the reviewer, which has to be right about what it quotes,
// works hardest. Left to itself the API picks a model-dependent level, which
// ranges from medium to high.
const CLAUDE_ROLE_EFFORT: Record<AssistantRole, EffortLevel> = {
	continuation: 'low',
	utility: 'low',
	chat: 'medium',
	coauthor: 'medium',
	reviewer: 'high'
};

// Claude models that take an effort level. Older and smaller ones (Haiku 4.5,
// Sonnet 4.5) reject it, and a name this does not recognise is left alone, so
// a request never fails over a setting the writer did not choose.
const CLAUDE_EFFORT_MODELS =
	/^claude-((fable|mythos|opus|sonnet|haiku)-5|opus-4-[5-8]|sonnet-4-6)(\b|-)/;

export function modelTakesEffort(model: string): boolean {
	return CLAUDE_EFFORT_MODELS.test(model);
}

// The effort a role's Claude model runs at when nothing sets one.
export function defaultEffort(role: AssistantRole): EffortLevel {
	return CLAUDE_ROLE_EFFORT[role];
}

// The effort a Claude request carries: the role's own, else the Codex default
// where the model takes one, else none.
export function claudeEffort(
	role: AssistantRole,
	model: string,
	tuning: RoleTuning | undefined
): EffortLevel | undefined {
	if (tuning?.effort) return tuning.effort;
	return modelTakesEffort(model) ? CLAUDE_ROLE_EFFORT[role] : undefined;
}

// The model a role runs on: its own, else the chat model, else the provider's
// suggestion for the role, else whatever is set. Shared so the settings page
// labels an unpicked role with what the server will actually run.
export function resolveRoleModel(
	models: Partial<Record<AssistantRole, string>>,
	role: AssistantRole,
	suggested: string
): string {
	return models[role] || models.chat || suggested || Object.values(models).find(Boolean) || '';
}
