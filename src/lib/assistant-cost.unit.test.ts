import { describe, it, expect } from 'vitest';
import { cacheReadRate, cacheWriteRate, usageCostUsd } from './assistant-cost';

const price = { prompt: 0.001, completion: 0.002 };

describe('usageCostUsd', () => {
	it('prices a row with no cache shares at the plain price', () => {
		const plain = 100 * 0.001 + 10 * 0.002;
		expect(usageCostUsd(price, { promptTokens: 100, completionTokens: 10 })).toBeCloseTo(plain, 10);
		expect(
			usageCostUsd(price, {
				promptTokens: 100,
				completionTokens: 10,
				cachedPromptTokens: null,
				cacheWriteTokens: null,
				cacheWrite1hTokens: null
			})
		).toBeCloseTo(plain, 10);
	});

	it('prices a first read at the write rate of its cache lifetime', () => {
		const written = { promptTokens: 1000, completionTokens: 0, cacheWriteTokens: 1000 };
		expect(usageCostUsd(price, written)).toBeCloseTo(cacheWriteRate('5m'), 10);
		expect(usageCostUsd(price, { ...written, cacheWrite1hTokens: 1000 })).toBeCloseTo(
			cacheWriteRate('1h'),
			10
		);
	});

	it('prices a mixed row share by share', () => {
		// 1000 prompt tokens: 400 read from the cache, 300 written (100 of them
		// to the one hour cache), 300 fresh.
		const cost = usageCostUsd(
			price,
			{
				promptTokens: 1000,
				completionTokens: 50,
				cachedPromptTokens: 400,
				cacheWriteTokens: 300,
				cacheWrite1hTokens: 100
			},
			true
		);
		expect(cost).toBeCloseTo((300 + 400 * 0.1 + 200 * 1.25 + 100 * 2) * 0.001 + 50 * 0.002, 10);
	});

	it('gives a cache read no discount unless the provider is Claude', () => {
		const usage = { promptTokens: 1000, completionTokens: 0, cachedPromptTokens: 400 };
		expect(usageCostUsd(price, usage, false)).toBeCloseTo(1000 * 0.001, 10);
		expect(usageCostUsd(price, usage, true)).toBeCloseTo((600 + 400 * 0.1) * 0.001, 10);
		expect(cacheReadRate(false)).toBeGreaterThanOrEqual(cacheReadRate(true));
	});
});
