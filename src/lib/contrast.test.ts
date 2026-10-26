import { describe, expect, it } from 'vitest';
import { accentFill, accentFillReadable, contrastRatio, mixWithBlack } from './contrast';

describe('contrastRatio', () => {
	it('matches the WCAG reference values', () => {
		expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5);
		expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
		expect(contrastRatio('#fff', '#fff')).toBe(1);
	});

	it('is symmetric', () => {
		expect(contrastRatio('#5b8cff', '#f7f7f5')).toBe(contrastRatio('#f7f7f5', '#5b8cff'));
	});
});

describe('mixWithBlack', () => {
	it('keeps the colour at 100% and reaches black at 0%', () => {
		expect(mixWithBlack('#5b8cff', 1)).toBe('#5b8cff');
		expect(mixWithBlack('#5b8cff', 0)).toBe('#000000');
	});

	it('matches the browser oklab mix for the default accent', () => {
		// color-mix(in oklab, #5b8cff 75%, black) renders as rgb(59, 93, 174).
		expect(accentFill('#5b8cff')).toBe('#3b5dae');
	});
});

describe('accentFillReadable', () => {
	it('accepts the default accent and rejects a pale custom colour', () => {
		expect(accentFillReadable('#5b8cff')).toBe(true);
		expect(accentFillReadable('#ffff66')).toBe(false);
		expect(accentFillReadable('#f0f0f0')).toBe(false);
	});
});
