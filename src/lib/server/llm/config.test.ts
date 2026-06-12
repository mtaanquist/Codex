import { describe, it, expect } from 'vitest';
import { assistantGate, type StoredAccountConfig, type StoredStoryOverride } from './config';

function account(partial: Partial<StoredAccountConfig> = {}): StoredAccountConfig {
	return {
		enabled: false,
		assistantName: '',
		persona: 'balanced',
		provider: 'custom',
		endpoint: '',
		apiKeyEnc: null,
		models: {},
		toolCallBudget: 8,
		...partial
	};
}

describe('assistantGate', () => {
	it('is dark everywhere when no endpoint is configured', () => {
		expect(assistantGate(account())).toEqual({
			configured: false,
			accountEnabled: false,
			tabEnabled: false,
			surfacesEnabled: false
		});
	});

	it('configured but the master is off: tab and surfaces stay dark', () => {
		const gate = assistantGate(account({ endpoint: 'http://local/v1', enabled: false }));
		expect(gate.configured).toBe(true);
		expect(gate.accountEnabled).toBe(false);
		expect(gate.tabEnabled).toBe(false);
		expect(gate.surfacesEnabled).toBe(false);
	});

	it('configured and the master on: tab and surfaces are live', () => {
		expect(assistantGate(account({ endpoint: 'http://local/v1', enabled: true }))).toEqual({
			configured: true,
			accountEnabled: true,
			tabEnabled: true,
			surfacesEnabled: true
		});
	});

	it('a story mute subtracts the surfaces but keeps the tab (to un-mute)', () => {
		const override: StoredStoryOverride = { enabled: false };
		const gate = assistantGate(account({ endpoint: 'http://local/v1', enabled: true }), override);
		expect(gate.tabEnabled).toBe(true);
		expect(gate.surfacesEnabled).toBe(false);
	});

	it('a story override cannot light the Assistant up when the account is off', () => {
		const override: StoredStoryOverride = { models: { chat: 'm' } };
		const gate = assistantGate(account({ endpoint: 'http://local/v1', enabled: false }), override);
		expect(gate.accountEnabled).toBe(false);
		expect(gate.tabEnabled).toBe(false);
		expect(gate.surfacesEnabled).toBe(false);
	});
});
