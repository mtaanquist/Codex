// How many tokens each part of a request may take, derived from the context
// window of the model the role resolves to. Pure, so the shares are testable
// without a database.

// The world context budget where the window is unknown. Provisional: calibrate
// against a corpus before trusting it.
export const DEFAULT_BUDGET_TOKENS = 6000;
// The side panel transcript budget where the window is unknown.
export const CHAT_BUDGET_TOKENS = 8000;

// Shares of the window, with a ceiling on each because every turn resends the
// transcript and the world context: on a 1M-token model an uncapped share would
// cost far more per message than it adds. The two shares together leave well
// over half the window for the persona, the tool schemas, and the reply.
const CONTEXT_WINDOW_SHARE = 0.15;
const CONTEXT_CEILING_TOKENS = 16000;
const CHAT_WINDOW_SHARE = 0.25;
const CHAT_CEILING_TOKENS = 32000;
// Below this a budget would hold too little to be worth sending.
const MIN_BUDGET_TOKENS = 1000;

export function windowBudget(
	contextWindow: number | undefined,
	share: number,
	fallback: number,
	ceiling = Infinity
): number {
	if (!contextWindow) return fallback;
	return Math.min(ceiling, Math.max(MIN_BUDGET_TOKENS, Math.floor(contextWindow * share)));
}

export function contextBudgetTokens(contextWindow: number | undefined): number {
	return windowBudget(
		contextWindow,
		CONTEXT_WINDOW_SHARE,
		DEFAULT_BUDGET_TOKENS,
		CONTEXT_CEILING_TOKENS
	);
}

export function chatBudgetTokens(contextWindow: number | undefined): number {
	return windowBudget(contextWindow, CHAT_WINDOW_SHARE, CHAT_BUDGET_TOKENS, CHAT_CEILING_TOKENS);
}
