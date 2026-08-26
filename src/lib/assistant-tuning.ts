// The Assistant's role names and the bounds on each per-role tuning value.
// Both the server config and the account settings page need to agree on these,
// and the settings page cannot import $lib/server, so they live here instead of
// being spelled once on each side. $lib/server/llm/config re-exports the roles
// and effort levels, so server callers keep one import.

// 'utility' covers the background work the writer never prompts directly:
// summary maintenance, entity extraction, and the recap.
export const ASSISTANT_ROLES = ['continuation', 'coauthor', 'reviewer', 'utility', 'chat'] as const;
export type AssistantRole = (typeof ASSISTANT_ROLES)[number];

// The Claude provider's own effort levels; every other endpoint ignores them.
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

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

export function defaultMaxTokens(role: AssistantRole): number {
	return role === 'reviewer' ? REVIEWER_MAX_TOKENS : DEFAULT_MAX_TOKENS;
}
