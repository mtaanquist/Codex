import { describe, it, expect } from 'vitest';
import {
	CHAT_BUDGET_TOKENS,
	DEFAULT_BUDGET_TOKENS,
	chatBudgetTokens,
	contextBudgetTokens
} from './budgets';

describe('context budgets', () => {
	it('keeps the fixed figures when the window is unknown', () => {
		expect(contextBudgetTokens(undefined)).toBe(DEFAULT_BUDGET_TOKENS);
		expect(chatBudgetTokens(undefined)).toBe(CHAT_BUDGET_TOKENS);
	});

	it('scales with a known window', () => {
		expect(contextBudgetTokens(32_768)).toBe(4915);
		expect(chatBudgetTokens(32_768)).toBe(8192);
		expect(contextBudgetTokens(65_536)).toBeGreaterThan(contextBudgetTokens(32_768));
		expect(chatBudgetTokens(65_536)).toBeGreaterThan(chatBudgetTokens(32_768));
	});

	it('stops at the ceiling on a large window', () => {
		expect(contextBudgetTokens(1_000_000)).toBe(16_000);
		expect(chatBudgetTokens(1_000_000)).toBe(32_000);
		expect(contextBudgetTokens(200_000)).toBe(16_000);
	});

	it('leaves room for the rest of the request on a small window', () => {
		const window = 8192;
		expect(contextBudgetTokens(window) + chatBudgetTokens(window)).toBeLessThan(window / 2);
		expect(contextBudgetTokens(2000)).toBe(1000);
	});
});
