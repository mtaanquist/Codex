import { describe, expect, it } from 'vitest';
import { defaultMaxTokens, roleMayThink } from './assistant-tuning';

describe('defaultMaxTokens', () => {
	it('keeps the plain defaults for a role that does not think', () => {
		expect(defaultMaxTokens('chat')).toBe(2048);
		expect(defaultMaxTokens('reviewer')).toBe(4096);
	});

	it('leaves room for thinking', () => {
		expect(defaultMaxTokens('chat', true)).toBe(16_384);
		expect(defaultMaxTokens('reviewer', true)).toBe(16_384);
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
