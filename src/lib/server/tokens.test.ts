import { describe, it, expect } from 'vitest';
import { hashToken } from './tokens';

describe('hashToken', () => {
	it('is deterministic and hex-encoded sha256', () => {
		expect(hashToken('abc')).toBe(hashToken('abc'));
		expect(hashToken('abc')).toMatch(/^[0-9a-f]{64}$/);
	});

	it('differs for different inputs', () => {
		expect(hashToken('one')).not.toBe(hashToken('two'));
	});
});
