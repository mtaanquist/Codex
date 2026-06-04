import { describe, it, expect, beforeEach } from 'vitest';
import { rateLimit, resetRateLimits } from './rate-limit';

beforeEach(() => resetRateLimits());

describe('rateLimit', () => {
	it('allows up to the limit, then blocks within the window', () => {
		const key = 'login:a@example.com';
		expect(rateLimit(key, 3, 1000, 0).allowed).toBe(true);
		expect(rateLimit(key, 3, 1000, 0).allowed).toBe(true);
		const third = rateLimit(key, 3, 1000, 0);
		expect(third.allowed).toBe(true);
		expect(third.remaining).toBe(0);

		const blocked = rateLimit(key, 3, 1000, 100);
		expect(blocked.allowed).toBe(false);
		expect(blocked.retryAfterSeconds).toBe(1); // 900ms left, rounded up
	});

	it('resets once the window has elapsed', () => {
		const key = 'reset:b@example.com';
		rateLimit(key, 1, 1000, 0);
		expect(rateLimit(key, 1, 1000, 500).allowed).toBe(false);
		expect(rateLimit(key, 1, 1000, 1000).allowed).toBe(true);
	});

	it('tracks keys independently', () => {
		expect(rateLimit('a', 1, 1000, 0).allowed).toBe(true);
		expect(rateLimit('a', 1, 1000, 0).allowed).toBe(false);
		expect(rateLimit('b', 1, 1000, 0).allowed).toBe(true);
	});
});
