import { describe, it, expect } from 'vitest';
import { adapterKind, normaliseProviderId, PROVIDER_PRESETS, providerPreset } from './presets';
import { providerFor } from './index';
import { anthropicProvider } from './anthropic';
import { openaiProvider } from './openai';

describe('provider presets', () => {
	it('normalises unknown or missing ids to custom', () => {
		expect(normaliseProviderId(undefined)).toBe('custom');
		expect(normaliseProviderId('something-else')).toBe('custom');
		expect(normaliseProviderId('anthropic')).toBe('anthropic');
	});

	it('routes anthropic to the native adapter and everything else to openai', () => {
		expect(providerFor('anthropic')).toBe(anthropicProvider);
		expect(providerFor('custom')).toBe(openaiProvider);
		for (const preset of PROVIDER_PRESETS) {
			expect(providerFor(preset.id)).toBe(
				preset.adapter === 'anthropic' ? anthropicProvider : openaiProvider
			);
		}
	});

	it('has a base URL, key hint, and docs link on every preset', () => {
		for (const preset of PROVIDER_PRESETS) {
			expect(preset.baseUrl).toMatch(/^https:\/\//);
			expect(preset.keyHint.length).toBeGreaterThan(0);
			expect(preset.docsUrl).toMatch(/^https:\/\//);
		}
	});

	it('custom has no preset entry', () => {
		expect(providerPreset('custom')).toBeUndefined();
		expect(adapterKind('custom')).toBe('openai-compatible');
	});
});
