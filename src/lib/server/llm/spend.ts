import type { ModelPricing } from './config.ts';
import type { TokenUsage } from './providers/types.ts';

// What a background run has spent so far, and whether that has passed the
// account's ceiling. A run adds the usage of every request it makes and checks
// the meter at a boundary where stopping stages nothing partial.
//
// A cost figure only ever exists when the model that answered has a price in
// the discovered snapshot. Without one the meter records that the cap could not
// be applied, and the run says so; it never guesses a price and never skips the
// ceiling in silence.

// The line a result and a notification carry when a cap was set but the run
// could not price itself.
export const CAP_NOT_APPLIED_MESSAGE =
	'A spend cap is set but the model has no known price, so it was not applied.';

export function requestCostUsd(
	pricing: ModelPricing | undefined,
	model: string,
	usage: TokenUsage
): number | undefined {
	const price = pricing?.[model];
	if (!price) return undefined;
	return usage.promptTokens * price.prompt + usage.completionTokens * price.completion;
}

export class SpendMeter {
	readonly capUsd: number | undefined;
	private readonly pricing: ModelPricing | undefined;
	private usd = 0;
	private unpriced = false;

	constructor(opts: { pricing?: ModelPricing; capUsd?: number }) {
		this.pricing = opts.pricing;
		this.capUsd = opts.capUsd;
	}

	// One request's reported usage. A request the endpoint reported no counts for
	// adds nothing, and a model with no price marks the run unpriceable.
	record(model: string, usage?: TokenUsage): void {
		if (!this.capUsd) return;
		const cost = usage ? requestCostUsd(this.pricing, model, usage) : undefined;
		if (cost === undefined) {
			if (!this.pricing?.[model]) this.unpriced = true;
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

	// A cap was set, but at least one request ran on a model with no known price,
	// so the ceiling could not be enforced over the whole run.
	get notApplied(): boolean {
		return this.capUsd !== undefined && this.unpriced;
	}
}
