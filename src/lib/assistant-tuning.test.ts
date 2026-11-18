import { describe, expect, it } from 'vitest';
import { claudeEffort, defaultMaxTokens, roleMayThink } from './assistant-tuning';

describe('defaultMaxTokens', () => {
	it('keeps the plain defaults for a role that does not think', () => {
		expect(defaultMaxTokens('chat')).toBe(2048);
		expect(defaultMaxTokens('reviewer')).toBe(4096);
	});

	it('leaves room for thinking', () => {
		expect(defaultMaxTokens('chat', true)).toBe(16_384);
		expect(defaultMaxTokens('reviewer', true)).toBe(16_384);
	});

	it('holds the thinking room to a quarter of a known window', () => {
		expect(defaultMaxTokens('reviewer', true, 200_000)).toBe(16_384);
		expect(defaultMaxTokens('reviewer', true, 32_768)).toBe(8192);
		// Never below the plain default.
		expect(defaultMaxTokens('reviewer', true, 8192)).toBe(4096);
	});
});

describe('roleMayThink', () => {
	it('is true on Claude whatever the role sets', () => {
		expect(roleMayThink(true, undefined)).toBe(true);
		expect(roleMayThink(true, { thinking: false })).toBe(true);
	});

	it('elsewhere follows Thinking and effort', () => {
		expect(roleMayThink(false, undefined)).toBe(false);
		expect(roleMayThink(false, { thinking: false })).toBe(false);
		expect(roleMayThink(false, { thinking: true })).toBe(true);
		expect(roleMayThink(false, { effort: 'high' })).toBe(true);
	});
});

describe('claudeEffort', () => {
	it("keeps the role's own effort", () => {
		expect(claudeEffort('continuation', 'claude-haiku-5-5', { effort: 'max' })).toBe('max');
	});

	it('gives each role its default on a model that takes effort', () => {
		expect(claudeEffort('continuation', 'claude-haiku-5-5', undefined)).toBe('low');
		expect(claudeEffort('utility', 'claude-haiku-5-5', {})).toBe('low');
		expect(claudeEffort('chat', 'claude-sonnet-5-5', undefined)).toBe('medium');
		expect(claudeEffort('coauthor', 'claude-sonnet-5', undefined)).toBe('medium');
		expect(claudeEffort('reviewer', 'claude-opus-5-5', undefined)).toBe('high');
		expect(claudeEffort('reviewer', 'claude-opus-4-8', undefined)).toBe('high');
		expect(claudeEffort('reviewer', 'claude-fable-5-2', undefined)).toBe('high');
		expect(claudeEffort('reviewer', 'claude-opus-4-5-20251101', undefined)).toBe('high');
	});

	it('sends none to a model that rejects effort or is not recognised', () => {
		expect(claudeEffort('continuation', 'claude-haiku-4-5', undefined)).toBeUndefined();
		expect(claudeEffort('chat', 'claude-sonnet-4-5', undefined)).toBeUndefined();
		expect(claudeEffort('chat', 'claude-opus-50', undefined)).toBeUndefined();
		expect(claudeEffort('chat', 'my-proxy-model', undefined)).toBeUndefined();
	});
});
