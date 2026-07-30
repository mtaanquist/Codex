import { describe, expect, it } from 'vitest';
import { isApplePlatform } from './keys';

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
