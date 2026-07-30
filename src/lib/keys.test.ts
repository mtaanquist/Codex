import { describe, expect, it } from 'vitest';
import { appleShortcutLabels, isApplePlatform } from './keys';

describe('isApplePlatform', () => {
	it('recognises Apple platform strings', () => {
		expect(isApplePlatform('MacIntel')).toBe(true);
		expect(isApplePlatform('macOS')).toBe(true);
		expect(isApplePlatform('iPhone')).toBe(true);
		expect(isApplePlatform('iPad')).toBe(true);
	});

	it('leaves everything else on Ctrl and Alt', () => {
		expect(isApplePlatform('Win32')).toBe(false);
		expect(isApplePlatform('Windows')).toBe(false);
		expect(isApplePlatform('Linux x86_64')).toBe(false);
		expect(isApplePlatform('')).toBe(false);
	});
});

describe('appleShortcutLabels', () => {
	it('rewrites combo labels and leaves bare key names alone', () => {
		expect(appleShortcutLabels('press Ctrl+Alt+N, then Ctrl+Enter')).toBe(
			'press Cmd+Option+N, then Cmd+Enter'
		);
		// Prose naming the keys without a combo stays as written, so the
		// shortcuts article's own convention line survives the swap.
		expect(appleShortcutLabels('Cmd and Option on a Mac, Ctrl and Alt everywhere else.')).toBe(
			'Cmd and Option on a Mac, Ctrl and Alt everywhere else.'
		);
		expect(appleShortcutLabels('an image with alt+title text')).toBe(
			'an image with alt+title text'
		);
	});
});
