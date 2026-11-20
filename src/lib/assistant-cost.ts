// What a request costs, from its token counts and a per-token price. The one
// place the cache rates live: the spend meter, the review estimate, and the
// usage list on the account page all price through here.

export type TokenPrice = { prompt: number; completion: number };

// The counts a cost is built from. The cache counts are subsets of
// promptTokens: cacheWrite1hTokens of cacheWriteTokens, and cacheWriteTokens
// and cachedPromptTokens of promptTokens. Absent or null means none.
export type CostedUsage = {
	promptTokens: number;
	completionTokens: number;
	cachedPromptTokens?: number | null;
	cacheWriteTokens?: number | null;
	cacheWrite1hTokens?: number | null;
};

// Cache reads bill at a fraction of fresh prompt tokens, and the fraction is
// only known for Claude: a tenth, or less on some models, so a tenth errs
// high. OpenAI-compatible endpoints report cached tokens too, but what they
// charge for them runs from a tenth to the full price depending on who is
// serving, so those tokens get no discount here. A figure for such an
// endpoint can read high; it never reads low, and a cap never stops late.
const CLAUDE_CACHE_READ_RATE = 0.1;
const UNKNOWN_CACHE_READ_RATE = 1;

// What a token read from the endpoint's prompt cache bills at, as a multiple
// of the plain prompt price. claude: the account's provider is Claude.
export function cacheReadRate(claude: boolean): number {
	return claude ? CLAUDE_CACHE_READ_RATE : UNKNOWN_CACHE_READ_RATE;
}
// Cache writes bill above the plain prompt rate. Only Claude reports them, at
// these multiples for its five-minute and one-hour caches.
const CACHE_WRITE_RATE = 1.25;
const CACHE_WRITE_1H_RATE = 2;

// What text sent for the first time bills at, as a multiple of the plain
// prompt price, when it is written to a cache of this lifetime.
export function cacheWriteRate(ttl: '5m' | '1h'): number {
	return ttl === '1h' ? CACHE_WRITE_1H_RATE : CACHE_WRITE_RATE;
}

function share(value: number | null | undefined, max: number): number {
	return Math.min(Math.max(value ?? 0, 0), max);
}

// claude: whether the request went to the Claude provider (see cacheReadRate).
export function usageCostUsd(price: TokenPrice, usage: CostedUsage, claude = false): number {
	const cached = share(usage.cachedPromptTokens, usage.promptTokens);
	const written = share(usage.cacheWriteTokens, usage.promptTokens - cached);
	const writtenHour = share(usage.cacheWrite1hTokens, written);
	const fresh = usage.promptTokens - cached - written;
	const promptUnits =
		fresh +
		cached * cacheReadRate(claude) +
		(written - writtenHour) * CACHE_WRITE_RATE +
		writtenHour * CACHE_WRITE_1H_RATE;
	return promptUnits * price.prompt + usage.completionTokens * price.completion;
}
