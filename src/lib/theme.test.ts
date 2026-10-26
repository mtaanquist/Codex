import { describe, expect, it } from 'vitest';
import { storedChoice, THEME_CHOICES } from './theme';

describe('storedChoice', () => {
	it('reads a stored palette back as the choice', () => {
		expect(storedChoice('light')).toBe('light');
		expect(storedChoice('warm')).toBe('warm');
		expect(storedChoice('dark')).toBe('dark');
	});

	it('treats nothing stored, or a malformed value, as System', () => {
		expect(storedChoice(null)).toBe('system');
		expect(storedChoice('purple')).toBe('system');
	});
});

describe('THEME_CHOICES', () => {
	it('offers every theme once, System last', () => {
		expect(THEME_CHOICES.map((c) => c.id)).toEqual(['light', 'warm', 'dark', 'system']);
	});
});
