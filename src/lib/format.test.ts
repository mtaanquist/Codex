import { describe, it, expect } from 'vitest';
import { pluralSuffix, formatNumber, compactCount } from './format';

describe('pluralSuffix', () => {
	it('is empty for exactly one', () => {
		expect(pluralSuffix(1)).toBe('');
	});

	it('is "s" for zero and for many', () => {
		expect(pluralSuffix(0)).toBe('s');
		expect(pluralSuffix(2)).toBe('s');
		expect(pluralSuffix(42)).toBe('s');
	});
});

describe('formatNumber', () => {
	it('groups thousands', () => {
		expect(formatNumber(1234)).toBe('1,234');
		expect(formatNumber(1234567)).toBe('1,234,567');
	});

	it('leaves small numbers ungrouped', () => {
		expect(formatNumber(0)).toBe('0');
		expect(formatNumber(999)).toBe('999');
	});
});

describe('compactCount', () => {
	it('is empty for non-positive counts', () => {
		expect(compactCount(0)).toBe('');
		expect(compactCount(-5)).toBe('');
	});

	it('shows the raw count below a thousand', () => {
		expect(compactCount(1)).toBe('1');
		expect(compactCount(999)).toBe('999');
	});

	it('shows one decimal of thousands at and above a thousand', () => {
		expect(compactCount(1000)).toBe('1.0k');
		expect(compactCount(1234)).toBe('1.2k');
		expect(compactCount(12000)).toBe('12.0k');
	});
});
