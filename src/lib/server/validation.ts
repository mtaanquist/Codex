import { error } from '@sveltejs/kit';

// Server-side request validation shared by the API routes.

// A prose body (scene, note, entity description) past this is refused: every
// changed save also writes a full-body revision row, so an unbounded body
// would balloon storage. Two million characters is far beyond any real scene.
export const MAX_PROSE_CHARS = 2_000_000;
// A name shown wherever the author is rendered.
export const MAX_DISPLAY_NAME = 120;

// Parses a JSON request body, returning a clean 400 instead of a 500 when the
// body is missing or malformed. The bare request.json() throws a SyntaxError on
// a non-JSON body, which surfaces as an unhandled 500.
export async function readJson<T = Record<string, unknown>>(request: Request): Promise<T> {
	const body = await request.json().catch(() => null);
	if (body === null || typeof body !== 'object') error(400, 'expected a JSON body');
	return body as T;
}

// Enforces a maximum length on a prose body, after the caller has checked it is
// a string. Refuses an over-long body rather than storing it.
export function checkProseLength(value: string): void {
	if (value.length > MAX_PROSE_CHARS) error(413, 'that is too long to save');
}
