import { describe, it, expect, beforeEach } from 'vitest';
import { rateLimit, resetRateLimits, uploadLimit, writeLimit } from './rate-limit';

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

describe('write and upload budgets', () => {
	it('keeps the write and upload budgets in separate buckets per user', () => {
		// A user's uploads do not draw down their (much larger) write budget.
		expect(writeLimit('u1', 0).allowed).toBe(true);
		expect(uploadLimit('u1', 0).allowed).toBe(true);
		expect(writeLimit('u1', 0).remaining).toBeGreaterThan(uploadLimit('u1', 0).remaining);
	});

	it('limits one user without affecting another', () => {
		// Spend u1's upload budget; u2 is untouched.
		let last = uploadLimit('u1', 0);
		for (let i = 0; i < 200 && last.allowed; i++) last = uploadLimit('u1', 0);
		expect(last.allowed).toBe(false);
		expect(uploadLimit('u2', 0).allowed).toBe(true);
	});
});
