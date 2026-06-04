import { describe, it, expect } from 'vitest';
import {
	ACCENT_PRESETS,
	DEFAULT_ACCENT,
	isAccentColor,
	isTheme,
	normaliseAccent
} from './appearance';

describe('isTheme', () => {
	it('accepts the three themes and rejects anything else', () => {
		expect(isTheme('system')).toBe(true);
		expect(isTheme('light')).toBe(true);
		expect(isTheme('dark')).toBe(true);
		expect(isTheme('Dark')).toBe(false);
		expect(isTheme('')).toBe(false);
		expect(isTheme(undefined)).toBe(false);
	});
});

describe('isAccentColor', () => {
	it('accepts 3- and 6-digit hex in any case, rejects the rest', () => {
		expect(isAccentColor('#abc')).toBe(true);
		expect(isAccentColor('#AABBCC')).toBe(true);
		expect(isAccentColor('#5b8cff')).toBe(true);
		expect(isAccentColor('aabbcc')).toBe(false);
		expect(isAccentColor('#12')).toBe(false);
		expect(isAccentColor('#12345')).toBe(false);
		expect(isAccentColor('red')).toBe(false);
		expect(isAccentColor(123)).toBe(false);
	});
});

describe('normaliseAccent', () => {
	it('expands shorthand, lowercases, and falls back to the default', () => {
		expect(normaliseAccent('#ABC')).toBe('#aabbcc');
		expect(normaliseAccent('#5B8CFF')).toBe('#5b8cff');
		expect(normaliseAccent('not a colour')).toBe(DEFAULT_ACCENT);
		expect(normaliseAccent(undefined)).toBe(DEFAULT_ACCENT);
	});
});

describe('ACCENT_PRESETS', () => {
	it('are all valid accent colours', () => {
		for (const preset of ACCENT_PRESETS) {
			expect(isAccentColor(preset.value)).toBe(true);
		}
	});
});
