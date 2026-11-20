// What a confirm step says about the cost of a run before it starts. One
// wording for every surface that asks (a review, a scene or chapter draft).

export const money = (usd: number) => usd.toFixed(2);

export const NO_PRICE_NOTE = 'This model has no price on record, so the cost cannot be shown.';

export function capNotAppliedNote(capUsd: number): string {
	return `Your spend cap of $${money(capUsd)} cannot be applied to a model with no known price.`;
}

// The surface adds what to do about it.
export function overWarnNote(warnUsd: number): string {
	return `That is more than your warning limit of $${money(warnUsd)}.`;
}
