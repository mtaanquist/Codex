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

// Per-user write budgets, keyed by user id. Autosave is debounced on the
// client, so even heavy multi-editor writing stays well under WRITE_PER_MINUTE;
// the cap only slows a client hammering the write endpoints in a loop. Uploads
// are far heavier per request, so they get their own tighter bucket. These run
// in one process today (see the single-replica note in docs/SELF-HOSTING.md);
// a shared store is the prerequisite for multiple app replicas.
const WRITE_PER_MINUTE = 600;
const UPLOAD_PER_MINUTE = 60;
// The writer pays their own provider, so this is not a cost cap; it bounds how
// many long-lived Assistant streams one account can open on the single process.
const ASSISTANT_PER_MINUTE = 60;

// The autosave budget: scene, entity, and note saves all draw on it per user.
export function writeLimit(userId: string, now: number = Date.now()): RateLimitResult {
	return rateLimit(`write:${userId}`, WRITE_PER_MINUTE, 60 * 1000, now);
}

// The upload budget: image paste, drop, and cover uploads per user.
export function uploadLimit(userId: string, now: number = Date.now()): RateLimitResult {
	return rateLimit(`upload:${userId}`, UPLOAD_PER_MINUTE, 60 * 1000, now);
}

// The Assistant budget: chat and other generation turns per user.
export function assistantLimit(userId: string, now: number = Date.now()): RateLimitResult {
	return rateLimit(`assistant:${userId}`, ASSISTANT_PER_MINUTE, 60 * 1000, now);
}

// The export budget: requesting an account, story, or universe export per user.
// Each request enqueues a heavy worker build, so the bucket is small and the
// window is long.
const EXPORT_PER_HOUR = 20;
export function exportLimit(userId: string, now: number = Date.now()): RateLimitResult {
	return rateLimit(`export:${userId}`, EXPORT_PER_HOUR, 3600 * 1000, now);
}

// Clears all counters. For tests; not used by the app.
export function resetRateLimits(): void {
	windows.clear();
}
