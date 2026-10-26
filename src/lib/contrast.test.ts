import { describe, expect, it } from 'vitest';
import { ACCENT_PRESETS } from './appearance';
import { accentFill, accentProblem, contrastRatio, mixWithBlack } from './contrast';

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

describe('accentProblem', () => {
	it('passes every preset', () => {
		for (const { name, value } of ACCENT_PRESETS) expect(accentProblem(value), name).toBeNull();
	});

	it('flags a pale custom colour as too light', () => {
		expect(accentProblem('#ffff66')).toBe('too-light');
		expect(accentProblem('#f0f0f0')).toBe('too-light');
	});

	it('flags a colour whose button passes but whose text fails on warm paper', () => {
		// White on its fill is about 5.2, its text shade on warm --bg about 4.3.
		expect(contrastRatio('#ffffff', accentFill('#7aa0ff'))).toBeGreaterThan(4.5);
		expect(accentProblem('#7aa0ff')).toBe('too-light');
	});

	it('flags a deep colour as too dark for the dark theme', () => {
		expect(accentProblem('#203060')).toBe('too-dark');
	});
});
