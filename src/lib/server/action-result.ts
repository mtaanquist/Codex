import { error } from '@sveltejs/kit';

// Maps a failed server-action result to an HTTP error: a "not found" reason
// becomes a 404, anything else a 400. Centralised so the entity routes share
// one mapping instead of each copying the same string check.
export function throwActionError(result: { reason: string }): never {
	throw error(result.reason.includes('not found') ? 404 : 400, result.reason);
}
