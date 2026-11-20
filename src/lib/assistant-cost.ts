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

// Cache reads bill at a fraction of fresh prompt tokens. Providers and models
// differ, from a fortieth to a tenth; the tenth is applied to every endpoint,
// so a figure errs high rather than low.
const CACHED_PROMPT_RATE = 0.1;
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

export function usageCostUsd(price: TokenPrice, usage: CostedUsage): number {
	const cached = share(usage.cachedPromptTokens, usage.promptTokens);
	const written = share(usage.cacheWriteTokens, usage.promptTokens - cached);
	const writtenHour = share(usage.cacheWrite1hTokens, written);
	const fresh = usage.promptTokens - cached - written;
	const promptUnits =
		fresh +
		cached * CACHED_PROMPT_RATE +
		(written - writtenHour) * CACHE_WRITE_RATE +
		writtenHour * CACHE_WRITE_1H_RATE;
	return promptUnits * price.prompt + usage.completionTokens * price.completion;
}
