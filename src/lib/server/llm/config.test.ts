import { describe, it, expect } from 'vitest';
import {
	assistantGate,
	chatModelInfo,
	modelContextWindow,
	pickModel,
	type ResolvedConfig,
	type StoredAccountConfig,
	type StoredStoryOverride,
	withRoleOverride
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
		webSearch: false,
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
		webSearch: false,
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

describe('the suggested model', () => {
	it("runs a Claude role with nothing picked on the guide's model for it", () => {
		const config = resolved({ provider: 'anthropic' });
		expect(pickModel(config, 'continuation')).toBe('claude-haiku-5-5');
		expect(pickModel(config, 'chat')).toBe('claude-sonnet-5-5');
		expect(pickModel(config, 'reviewer')).toBe('claude-opus-5-5');
	});

	it('still follows the chat model first, as before', () => {
		const config = resolved({ provider: 'anthropic', models: { chat: 'claude-x' } });
		expect(pickModel(config, 'reviewer')).toBe('claude-x');
	});

	it('beats a pick made only for another role', () => {
		const config = resolved({ provider: 'anthropic', models: { reviewer: 'claude-opus-5-5' } });
		expect(pickModel(config, 'continuation')).toBe('claude-haiku-5-5');
	});

	it('without one, a role falls back to whatever is picked, as before', () => {
		const config = resolved({ provider: 'gemini', models: { reviewer: 'gemini-pro' } });
		expect(pickModel(config, 'continuation')).toBe('gemini-pro');
	});

	it('leaves a provider without a verified id and no picks with no model', () => {
		expect(pickModel(resolved({ provider: 'gemini' }), 'chat')).toBe('');
	});
});

describe('withRoleOverride', () => {
	it('lays a chat model and effort over the role on Claude', () => {
		const config = resolved({
			provider: 'anthropic',
			models: { chat: 'claude-sonnet-5', reviewer: 'claude-sonnet-5' }
		});
		const out = withRoleOverride(config, 'chat', { model: 'claude-opus-5', effort: 'high' });
		expect(pickModel(out, 'chat')).toBe('claude-opus-5');
		expect(out.tuning.chat?.effort).toBe('high');
		expect(pickModel(out, 'reviewer')).toBe('claude-sonnet-5');
	});

	it('drops the effort on any other provider', () => {
		const config = resolved({ provider: 'custom', models: { chat: 'local' } });
		const out = withRoleOverride(config, 'chat', { effort: 'high' });
		expect(out).toBe(config);
	});

	it('drops the effort on a Claude model that does not take one', () => {
		const config = resolved({ provider: 'anthropic', models: { chat: 'claude-sonnet-4-5' } });
		expect(withRoleOverride(config, 'chat', { effort: 'high' })).toBe(config);
		const out = withRoleOverride(config, 'chat', { model: 'claude-haiku-4-5', effort: 'high' });
		expect(out.tuning.chat?.effort).toBeUndefined();
	});

	it("drops the account's effort when the chat picks a model without one", () => {
		const config = resolved({
			provider: 'anthropic',
			models: { chat: 'claude-opus-5' },
			tuning: { chat: { effort: 'high', temperature: 0.5 } }
		});
		const out = withRoleOverride(config, 'chat', { model: 'claude-haiku-4-5' });
		expect(out.tuning.chat).toEqual({ temperature: 0.5 });
		expect(config.tuning.chat?.effort).toBe('high');
		expect(chatModelInfo(out).effort).toBeNull();
	});

	it('leaves the config alone without a setting', () => {
		const config = resolved();
		expect(withRoleOverride(config, 'chat', {})).toBe(config);
		expect(withRoleOverride(config, 'chat', undefined)).toBe(config);
	});
});

describe('chatModelInfo', () => {
	it('reports the chat model and its default effort on Claude', () => {
		expect(
			chatModelInfo(resolved({ provider: 'anthropic', models: { chat: 'claude-sonnet-5' } }))
		).toEqual({ model: 'claude-sonnet-5', effort: 'medium', claude: true });
	});

	it('reports no effort elsewhere', () => {
		expect(chatModelInfo(resolved({ models: { chat: 'local' } }))).toEqual({
			model: 'local',
			effort: null,
			claude: false
		});
	});
});
