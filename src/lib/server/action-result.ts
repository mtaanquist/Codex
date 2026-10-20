import { error } from '@sveltejs/kit';

// Why a server action refused. The code picks the HTTP status; the reason is
// a sentence the writer may see, so it never decides the status itself.
export type ActionErrorCode = 'not_found' | 'invalid' | 'conflict';

export type ActionFailure = { ok: false; code: ActionErrorCode; reason: string };

const STATUS: Record<ActionErrorCode, number> = {
	not_found: 404,
	invalid: 400,
	conflict: 409
};

export function throwActionError(result: ActionFailure): never {
	throw error(STATUS[result.code], result.reason);
}
