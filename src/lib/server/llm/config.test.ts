import { describe, it, expect } from 'vitest';
import {
	assistantGate,
	modelContextWindow,
	pickModel,
	type ResolvedConfig,
	type StoredAccountConfig,
	type StoredStoryOverride
} from './config';

function account(partial: Partial<StoredAccountConfig> = {}): StoredAccountConfig {
	return {
		enabled: false,
		assistantName: '',
		persona: 'balanced',
		provider: 'custom',
		endpoint: '',
		apiKeyEnc: null,
		models: {},
		tuning: {},
		toolCallBudget: 8,
		toolProfile: 'full',
		...partial
	};
}

function resolved(partial: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return {
		assistantName: '',
		persona: 'balanced',
		provider: 'custom',
		endpoint: 'http://local/v1',
		apiKey: '',
		models: {},
		tuning: {},
		toolCallBudget: 8,
		toolProfile: 'full',
		modelContext: {},
		...partial
	};
}

describe('modelContextWindow', () => {
	it('returns the window of the model the role runs on', () => {
		const config = resolved({
			models: { chat: 'small', reviewer: 'large' },
			modelContext: { small: 8192, large: 200000 }
		});
		expect(modelContextWindow(config, 'reviewer')).toBe(200000);
		expect(modelContextWindow(config, 'chat')).toBe(8192);
	});

	it('follows the role fallback to the chat model', () => {
		const config = resolved({ models: { chat: 'small' }, modelContext: { small: 8192 } });
		expect(pickModel(config, 'continuation')).toBe('small');
		expect(modelContextWindow(config, 'continuation')).toBe(8192);
	});

	it('is undefined when the model has no known window, or no model at all', () => {
		expect(modelContextWindow(resolved({ models: { chat: 'mystery' } }), 'chat')).toBeUndefined();
		expect(modelContextWindow(resolved(), 'chat')).toBeUndefined();
	});
});

describe('the utility role', () => {
	it('runs on the chat model when a config predating the role has none of its own', () => {
		const config = resolved({ models: { chat: 'small', reviewer: 'large' } });
		expect(pickModel(config, 'utility')).toBe('small');
	});

	it('runs on its own model once one is set, leaving the other roles alone', () => {
		const config = resolved({ models: { chat: 'small', utility: 'tiny' } });
		expect(pickModel(config, 'utility')).toBe('tiny');
		expect(pickModel(config, 'chat')).toBe('small');
		expect(pickModel(config, 'continuation')).toBe('small');
	});
});

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
