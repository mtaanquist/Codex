import { describe, it, expect } from 'vitest';
import { cacheWriteRate, usageCostUsd } from './assistant-cost';

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
});
