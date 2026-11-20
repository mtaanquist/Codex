import { usageCostUsd } from '../../assistant-cost.ts';
import type { ModelPricing } from './config.ts';
import type { TokenUsage } from './providers/types.ts';

// What a background run has spent so far, and whether that has passed the
// account's ceiling. A run adds the usage of every request it makes and checks
// the meter at a boundary where stopping stages nothing partial.
//
// A cost figure only ever exists when the model that answered has a price in
// the account's prices (discovered, or entered by the writer) AND the endpoint
// reported token counts for the request. Missing either one, the meter records that the cap could not be
// applied, and the run says so; it never guesses a price, never assumes a
// request was free, and never skips the ceiling in silence.

// The line a result and a notification carry when a cap was set but the run
// could not price itself because the model has no known price.
export const CAP_NOT_APPLIED_MESSAGE =
	'A spend cap is set but the model has no known price, so it was not applied. Enter its price in your Assistant settings.';

// The other reason a priced run cannot be metered: the endpoint answered at
// least one request without reporting how many tokens it billed, so that
// request could not be priced and the cap could not cover the whole run.
export const CAP_NOT_APPLIED_NO_USAGE_MESSAGE =
	'A spend cap is set but the endpoint did not report token counts for every request, so the cap could not be fully applied.';

export function requestCostUsd(
	pricing: ModelPricing | undefined,
	model: string,
	usage: TokenUsage
): number | undefined {
	const price = pricing?.[model];
	return price ? usageCostUsd(price, usage) : undefined;
}

// What a stopped run reports it spent: the figure, and whether it includes
// estimates (see SpendMeter.spentEstimated).
export function spentFields(meter: SpendMeter): { spentUsd: number; spentEstimated?: true } {
	return {
		spentUsd: meter.spentUsd,
		...(meter.spentEstimated ? { spentEstimated: true as const } : {})
	};
}

export class SpendMeter {
	readonly capUsd: number | undefined;
	private readonly pricing: ModelPricing | undefined;
	private usd: number;
	private unpriced = false;
	private unreported = false;
	private estimated = false;
	private readonly persist: ((spentUsd: number) => Promise<void>) | undefined;
	private saving: Promise<void> = Promise.resolve();

	// spentUsd seeds the meter with what an earlier attempt of the same job
	// already spent, so a retry does not get the whole ceiling again. persist is
	// handed the running total after every priced request; writes run one after
	// another, and flush waits for the last.
	constructor(opts: {
		pricing?: ModelPricing;
		capUsd?: number;
		spentUsd?: number;
		persist?: (spentUsd: number) => Promise<void>;
	}) {
		this.pricing = opts.pricing;
		this.capUsd = opts.capUsd;
		this.usd = opts.spentUsd ?? 0;
		this.persist = opts.persist;
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
		if (usage.estimated) this.estimated = true;
		this.usd += cost;
		if (this.persist) {
			const persist = this.persist;
			const total = this.usd;
			this.saving = this.saving.then(() => persist(total)).catch(() => {});
		}
	}

	flush(): Promise<void> {
		return this.saving;
	}

	get spentUsd(): number {
		return this.usd;
	}

	// True when spentUsd includes estimated counts (a failed attempt metered
	// from what had streamed, say) rather than only what the endpoint
	// reported. Notices mark the figure as estimated.
	get spentEstimated(): boolean {
		return this.estimated;
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
