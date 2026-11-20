import { describe, it, expect } from 'vitest';
import {
	CAP_NOT_APPLIED_MESSAGE,
	CAP_NOT_APPLIED_NO_USAGE_MESSAGE,
	SpendMeter,
	requestCostUsd,
	spentFields
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

	it('prices the cached share of the prompt at a tenth of the prompt rate on Claude', () => {
		const cost = requestCostUsd(
			pricing,
			'priced',
			{
				promptTokens: 1000,
				completionTokens: 0,
				cachedPromptTokens: 800
			},
			true
		);
		expect(cost).toBeCloseTo(200 * 0.001 + 800 * 0.001 * 0.1, 10);
	});

	it('prices cache writes above the prompt rate, the one-hour share highest', () => {
		const cost = requestCostUsd(
			pricing,
			'priced',
			{
				promptTokens: 1000,
				completionTokens: 0,
				cachedPromptTokens: 500,
				cacheWriteTokens: 400,
				cacheWrite1hTokens: 100
			},
			true
		);
		expect(cost).toBeCloseTo(0.001 * (100 + 500 * 0.1 + 300 * 1.25 + 100 * 2), 10);
	});

	it('never counts more cache writes than the prompt had left after its reads', () => {
		const cost = requestCostUsd(
			pricing,
			'priced',
			{
				promptTokens: 100,
				completionTokens: 0,
				cachedPromptTokens: 60,
				cacheWriteTokens: 500,
				cacheWrite1hTokens: 900
			},
			true
		);
		expect(cost).toBeCloseTo(0.001 * (60 * 0.1 + 40 * 2), 10);
	});

	it('never counts more cached tokens than the prompt held', () => {
		const cost = requestCostUsd(
			pricing,
			'priced',
			{
				promptTokens: 100,
				completionTokens: 0,
				cachedPromptTokens: 500
			},
			true
		);
		expect(cost).toBeCloseTo(100 * 0.001 * 0.1, 10);
	});

	it('gives cached tokens no discount on any other provider', () => {
		const usage = { promptTokens: 1000, completionTokens: 0, cachedPromptTokens: 800 };
		expect(requestCostUsd(pricing, 'priced', usage)).toBeCloseTo(1000 * 0.001, 10);
		expect(requestCostUsd(pricing, 'priced', usage, false)).toBeCloseTo(1000 * 0.001, 10);
	});
});

describe('SpendMeter', () => {
	it('meters cached tokens at a tenth only for Claude', () => {
		const usage = { promptTokens: 1000, completionTokens: 0, cachedPromptTokens: 900 };
		const other = new SpendMeter({ pricing, capUsd: 1 });
		other.record('priced', usage);
		expect(other.spentUsd).toBeCloseTo(1, 10);
		expect(other.capReached).toBe(true);

		const claude = new SpendMeter({ pricing, capUsd: 1, claude: true });
		claude.record('priced', usage);
		expect(claude.spentUsd).toBeCloseTo(0.19, 10);
		expect(claude.capReached).toBe(false);
	});

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

	it('still meters an estimate, and says the total includes one (#1116)', () => {
		const meter = new SpendMeter({ pricing, capUsd: 1 });
		meter.record('priced', { promptTokens: 100, completionTokens: 10 });
		expect(meter.spentEstimated).toBe(false);
		expect(spentFields(meter)).toEqual({ spentUsd: meter.spentUsd });
		meter.record('priced', { promptTokens: 100, completionTokens: 400, estimated: true });
		expect(meter.spentUsd).toBeCloseTo(0.2 + 0.8 + 0.02, 10);
		expect(meter.capReached).toBe(true);
		expect(spentFields(meter)).toEqual({ spentUsd: meter.spentUsd, spentEstimated: true });
	});

	it('says the cap was not fully applied when one request reported no counts (#1125)', () => {
		expect(CAP_NOT_APPLIED_NO_USAGE_MESSAGE).toMatch(/for every request/);
		expect(CAP_NOT_APPLIED_NO_USAGE_MESSAGE).toMatch(/not be fully applied/);
	});
});

describe('SpendMeter carried across attempts (#1117)', () => {
	it('starts from what an earlier attempt spent', () => {
		const meter = new SpendMeter({ pricing, capUsd: 1, spentUsd: 0.95 });
		expect(meter.capReached).toBe(false);
		meter.record('priced', { promptTokens: 100, completionTokens: 0 });
		expect(meter.spentUsd).toBeCloseTo(1.05, 6);
		expect(meter.capReached).toBe(true);
	});

	it('is at the ceiling from the start when an earlier attempt spent it', () => {
		expect(new SpendMeter({ pricing, capUsd: 1, spentUsd: 1 }).capReached).toBe(true);
	});

	it('hands each new total to persist, in order', async () => {
		const saved: number[] = [];
		const meter = new SpendMeter({
			pricing,
			capUsd: 10,
			persist: async (usd) => {
				await new Promise((resolve) => setTimeout(resolve, saved.length ? 0 : 5));
				saved.push(usd);
			}
		});
		meter.record('priced', { promptTokens: 100, completionTokens: 0 });
		meter.record('priced', { promptTokens: 100, completionTokens: 0 });
		await meter.flush();
		expect(saved.map((n) => Math.round(n * 1000) / 1000)).toEqual([0.1, 0.2]);
	});

	it('keeps metering when a write fails', async () => {
		const meter = new SpendMeter({
			pricing,
			capUsd: 10,
			persist: async () => {
				throw new Error('db down');
			}
		});
		meter.record('priced', { promptTokens: 100, completionTokens: 0 });
		await expect(meter.flush()).resolves.toBeUndefined();
		expect(meter.spentUsd).toBeCloseTo(0.1, 6);
	});
});
