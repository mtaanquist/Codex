import { describe, it, expect } from 'vitest';
import { ASSISTANT_ROLES } from '../../../assistant-tuning';
import { roleSuggestion } from './model-guide';
import { PROVIDER_IDS } from './presets';

describe('model guide', () => {
	it('has a suggestion for every role on every provider', () => {
		for (const provider of PROVIDER_IDS) {
			for (const role of ASSISTANT_ROLES) {
				expect(roleSuggestion(provider, role).text, `${provider} ${role}`).not.toBe('');
			}
		}
	});

	it('puts the fast roles on the fast tier and the Reviewer on the strongest', () => {
		expect(roleSuggestion('anthropic', 'continuation').id).toBe('claude-haiku-5-5');
		expect(roleSuggestion('anthropic', 'utility').id).toBe('claude-haiku-5-5');
		expect(roleSuggestion('anthropic', 'reviewer').id).toBe('claude-opus-5-5');
	});
});
