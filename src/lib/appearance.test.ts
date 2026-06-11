import { describe, it, expect } from 'vitest';
import {
	ACCENT_PRESETS,
	DEFAULT_ACCENT,
	isAccentColor,
	isConcreteTheme,
	isTheme,
	normaliseAccent,
	resolveTheme
} from './appearance';

describe('isTheme', () => {
	it('accepts the four themes and rejects anything else', () => {
		expect(isTheme('system')).toBe(true);
		expect(isTheme('light')).toBe(true);
		expect(isTheme('warm')).toBe(true);
		expect(isTheme('dark')).toBe(true);
		expect(isTheme('Dark')).toBe(false);
		expect(isTheme('')).toBe(false);
		expect(isTheme(undefined)).toBe(false);
	});
});

describe('isConcreteTheme', () => {
	it('accepts the palettes but not "system"', () => {
		expect(isConcreteTheme('light')).toBe(true);
		expect(isConcreteTheme('warm')).toBe(true);
		expect(isConcreteTheme('dark')).toBe(true);
		expect(isConcreteTheme('system')).toBe(false);
		expect(isConcreteTheme(undefined)).toBe(false);
	});
});

describe('resolveTheme', () => {
	it('returns an explicit choice unchanged, ignoring the OS preference', () => {
		expect(resolveTheme('warm', 'light', 'dark', true)).toBe('warm');
		expect(resolveTheme('light', 'warm', 'dark', true)).toBe('light');
		expect(resolveTheme('dark', 'light', 'dark', false)).toBe('dark');
	});
	it('follows the system mappings for "system"', () => {
		expect(resolveTheme('system', 'warm', 'dark', false)).toBe('warm');
		expect(resolveTheme('system', 'warm', 'dark', true)).toBe('dark');
		expect(resolveTheme('system', 'light', 'dark', false)).toBe('light');
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
