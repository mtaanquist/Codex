import type { ModelPricing } from './config.ts';
import type { TokenUsage } from './providers/types.ts';

// What a background run has spent so far, and whether that has passed the
// account's ceiling. A run adds the usage of every request it makes and checks
// the meter at a boundary where stopping stages nothing partial.
//
// A cost figure only ever exists when the model that answered has a price in
// the discovered snapshot AND the endpoint reported token counts for the
// request. Missing either one, the meter records that the cap could not be
// applied, and the run says so; it never guesses a price, never assumes a
// request was free, and never skips the ceiling in silence.

// The line a result and a notification carry when a cap was set but the run
// could not price itself because the model has no known price.
export const CAP_NOT_APPLIED_MESSAGE =
	'A spend cap is set but the model has no known price, so it was not applied.';

// The other reason a priced run cannot be metered: the endpoint answered without
// reporting how many tokens it billed, so there is nothing to price.
export const CAP_NOT_APPLIED_NO_USAGE_MESSAGE =
	'A spend cap is set but the endpoint did not report token counts, so it was not applied.';

// Cache reads bill at a fraction of fresh prompt tokens. Providers differ, but
// they cluster around a tenth; this provisional rate is applied to every
// endpoint until per-model cache pricing is discoverable.
const CACHED_PROMPT_RATE = 0.1;

export function requestCostUsd(
	pricing: ModelPricing | undefined,
	model: string,
	usage: TokenUsage
): number | undefined {
	const price = pricing?.[model];
	if (!price) return undefined;
	// cachedPromptTokens is a subset of promptTokens (see TokenUsage), so the
	// fresh share is what is left after it.
	const cached = Math.min(Math.max(usage.cachedPromptTokens ?? 0, 0), usage.promptTokens);
	const fresh = usage.promptTokens - cached;
	return (
		fresh * price.prompt +
		cached * price.prompt * CACHED_PROMPT_RATE +
		usage.completionTokens * price.completion
	);
}

export class SpendMeter {
	readonly capUsd: number | undefined;
	private readonly pricing: ModelPricing | undefined;
	private usd = 0;
	private unpriced = false;
	private unreported = false;

	constructor(opts: { pricing?: ModelPricing; capUsd?: number }) {
		this.pricing = opts.pricing;
		this.capUsd = opts.capUsd;
	}

	// One request's reported usage. A model with no price marks the run
	// unpriceable; so does a priced model the endpoint reported no counts for,
	// which would otherwise accrue nothing and let the ceiling pass unenforced.
	record(model: string, usage?: TokenUsage): void {
		if (!this.capUsd) return;
		if (!this.pricing?.[model]) {
			this.unpriced = true;
			return;
		}
		if (!usage) {
			this.unreported = true;
			return;
		}
		const cost = requestCostUsd(this.pricing, model, usage);
		if (cost === undefined) {
			this.unpriced = true;
			return;
		}
		this.usd += cost;
	}

	get spentUsd(): number {
		return this.usd;
	}

	// True once the run has spent its ceiling. Always false when there is no cap,
	// and false when nothing could be priced (see notApplied).
	get capReached(): boolean {
		return this.capUsd !== undefined && this.usd >= this.capUsd;
	}

	// A cap was set, but at least one request could not be priced, so the ceiling
	// could not be enforced over the whole run.
	get notApplied(): boolean {
		return this.capUsd !== undefined && (this.unpriced || this.unreported);
	}

	// Which of the two reasons to tell the writer about, when notApplied. An
	// unknown price is reported ahead of a missing usage report: it is the more
	// fundamental gap, and it is the one the writer can act on by choosing a
	// priced model. Undefined when the cap was applied cleanly.
	get notAppliedMessage(): string | undefined {
		if (!this.notApplied) return undefined;
		return this.unpriced ? CAP_NOT_APPLIED_MESSAGE : CAP_NOT_APPLIED_NO_USAGE_MESSAGE;
	}
}
