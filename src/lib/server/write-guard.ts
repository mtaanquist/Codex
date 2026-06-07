import { error } from '@sveltejs/kit';
import { uploadLimit, writeLimit } from './rate-limit';

// Per-user throttles for the write paths, shared by the autosave endpoints
// (scene, entity, note) and the asset upload. Both throw a 429 when the budget
// is spent. Autosave is debounced and the editor's save chain retries, so a
// brief throttle only delays a save rather than losing it.

export function rateLimitWrites(userId: string): void {
	const result = writeLimit(userId);
	if (!result.allowed) {
		error(
			429,
			`Too many saves in a short time. It will save again in ${result.retryAfterSeconds}s.`
		);
	}
}

export function rateLimitUploads(userId: string): void {
	const result = uploadLimit(userId);
	if (!result.allowed) {
		error(429, `Too many uploads in a short time. Try again in ${result.retryAfterSeconds}s.`);
	}
}
