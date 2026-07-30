import { describe, it, expect } from 'vitest';
import { SIGNUP_MODES, signupOffered } from './signup-mode';

describe('signupOffered', () => {
	it('offers sign-up where a visitor with no invite code can finish one', () => {
		expect(signupOffered('open')).toBe(true);
		expect(signupOffered('approval')).toBe(true);
	});

	// The old rule was mode !== 'none', which offered Request access on an
	// invite-only Codex, where a codeless visitor cannot succeed.
	it('does not offer sign-up when a code is the only way in, or when it is shut', () => {
		expect(signupOffered('invite')).toBe(false);
		expect(signupOffered('none')).toBe(false);
	});

	it('has an answer for every mode', () => {
		for (const mode of SIGNUP_MODES) {
			expect(typeof signupOffered(mode)).toBe('boolean');
		}
	});
});
