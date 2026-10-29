import { describe, it, expect } from 'vitest';
import {
	pluralSuffix,
	formatNumber,
	compactCount,
	formatLongDate,
	formatDate,
	formatDateTime,
	formatTime,
	narrowWeekday,
	relativeShort
} from './format';

// Local-time dates, so the output does not depend on the runner's timezone.
const june11 = new Date(2026, 5, 11, 9, 41);

describe('fixed display locale', () => {
	it('formats timestamps day first with a 24-hour clock', () => {
		expect(formatDateTime(june11)).toBe('11 Jun 2026, 09:41');
	});

	it('formats short dates day first', () => {
		expect(formatDate(june11)).toBe('11 Jun 2026');
	});

	it('formats the time of day', () => {
		expect(formatTime(june11)).toBe('09:41');
	});

	it('names the weekday of a calendar day by one letter', () => {
		expect(narrowWeekday('2026-06-11')).toBe('T');
		expect(narrowWeekday('2026-06-14')).toBe('S');
	});

	it('falls back to the short date after a week', () => {
		expect(relativeShort(june11)).toBe('11 Jun 2026');
	});
});

describe('formatLongDate', () => {
	it('writes the day, the full month and the year', () => {
		expect(formatLongDate(new Date(2026, 5, 11))).toBe('11 June 2026');
	});
});

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
