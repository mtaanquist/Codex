// A small in-memory fixed-window rate limiter. The hosted service runs as one
// process, so a shared module-level map is enough; counters reset on restart,
// which is fine for abuse-slowing rather than accounting. Keys are chosen by
// the caller, usually the targeted account (email or user id) so the limit is
// meaningful even when every request arrives from the same reverse proxy.

type Window = { count: number; resetAt: number };

const windows = new Map<string, Window>();

// Drop expired entries once the map grows past this, so keys do not accumulate.
const SWEEP_THRESHOLD = 5000;

export type RateLimitResult = { allowed: boolean; remaining: number; retryAfterSeconds: number };

export function rateLimit(
	key: string,
	limit: number,
	windowMs: number,
	now: number = Date.now()
): RateLimitResult {
	if (windows.size > SWEEP_THRESHOLD) {
		for (const [k, w] of windows) if (now >= w.resetAt) windows.delete(k);
	}

	const existing = windows.get(key);
	if (!existing || now >= existing.resetAt) {
		windows.set(key, { count: 1, resetAt: now + windowMs });
		return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
	}
	if (existing.count >= limit) {
		return {
			allowed: false,
			remaining: 0,
			retryAfterSeconds: Math.ceil((existing.resetAt - now) / 1000)
		};
	}
	existing.count++;
	return { allowed: true, remaining: limit - existing.count, retryAfterSeconds: 0 };
}

// Clears all counters. For tests; not used by the app.
export function resetRateLimits(): void {
	windows.clear();
}
