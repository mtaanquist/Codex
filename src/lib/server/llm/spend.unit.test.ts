import { describe, it, expect } from 'vitest';
import {
	CAP_NOT_APPLIED_MESSAGE,
	CAP_NOT_APPLIED_NO_USAGE_MESSAGE,
	SpendMeter,
	requestCostUsd
} from './spend';

const pricing = { priced: { prompt: 0.001, completion: 0.002 } };

describe('requestCostUsd', () => {
	it('prices prompt and completion tokens at the model rate', () => {
		expect(requestCostUsd(pricing, 'priced', { promptTokens: 100, completionTokens: 10 })).toBe(
			100 * 0.001 + 10 * 0.002
		);
	});

	it('is undefined for a model with no known price', () => {
		expect(
			requestCostUsd(pricing, 'other', { promptTokens: 100, completionTokens: 10 })
		).toBeUndefined();
		expect(
			requestCostUsd(undefined, 'priced', { promptTokens: 100, completionTokens: 10 })
		).toBeUndefined();
	});

	it('prices the cached share of the prompt at a tenth of the prompt rate', () => {
		const cost = requestCostUsd(pricing, 'priced', {
			promptTokens: 1000,
			completionTokens: 0,
			cachedPromptTokens: 800
		});
		expect(cost).toBeCloseTo(200 * 0.001 + 800 * 0.001 * 0.1, 10);
	});

	it('never counts more cached tokens than the prompt held', () => {
		const cost = requestCostUsd(pricing, 'priced', {
			promptTokens: 100,
			completionTokens: 0,
			cachedPromptTokens: 500
		});
		expect(cost).toBeCloseTo(100 * 0.001 * 0.1, 10);
	});
});

describe('SpendMeter', () => {
	it('accrues cost and reaches the cap', () => {
		const meter = new SpendMeter({ pricing, capUsd: 0.5 });
		meter.record('priced', { promptTokens: 100, completionTokens: 10 });
		expect(meter.spentUsd).toBeCloseTo(0.12, 10);
		expect(meter.capReached).toBe(false);
		expect(meter.notApplied).toBe(false);
		expect(meter.notAppliedMessage).toBeUndefined();
		meter.record('priced', { promptTokens: 1000, completionTokens: 0 });
		expect(meter.capReached).toBe(true);
	});

	it('does nothing at all without a cap', () => {
		const meter = new SpendMeter({ pricing });
		meter.record('other');
		expect(meter.notApplied).toBe(false);
		expect(meter.capReached).toBe(false);
	});

	it('flags a run on a model with no known price', () => {
		const meter = new SpendMeter({ pricing, capUsd: 1 });
		meter.record('other', { promptTokens: 100, completionTokens: 10 });
		expect(meter.notApplied).toBe(true);
		expect(meter.notAppliedMessage).toBe(CAP_NOT_APPLIED_MESSAGE);
	});

	it('flags a priced run the endpoint reported no token counts for', () => {
		const meter = new SpendMeter({ pricing, capUsd: 1 });
		meter.record('priced', { promptTokens: 100, completionTokens: 10 });
		meter.record('priced', undefined);
		expect(meter.spentUsd).toBeCloseTo(0.12, 10);
		expect(meter.notApplied).toBe(true);
		expect(meter.notAppliedMessage).toBe(CAP_NOT_APPLIED_NO_USAGE_MESSAGE);
	});

	it('reports the unknown price first when both gaps occur', () => {
		const meter = new SpendMeter({ pricing, capUsd: 1 });
		meter.record('priced', undefined);
		meter.record('other', { promptTokens: 1, completionTokens: 1 });
		expect(meter.notAppliedMessage).toBe(CAP_NOT_APPLIED_MESSAGE);
	});
});
