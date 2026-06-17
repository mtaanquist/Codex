// Shared client-side request helpers. Every endpoint re-checks ownership and
// auth server-side; these just shape the request and hand back either the
// parsed body or a friendly message for the caller to surface.
import { apiErrorMessage } from '$lib/format';

export type Result<T> = ({ ok: true } & T) | { ok: false; message: string };

/** POSTs JSON and returns the parsed body merged into the result, or a message. */
export async function post<T>(url: string, body: unknown, fallback: string): Promise<Result<T>> {
	const response = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
	if (!response.ok) return { ok: false, message: await apiErrorMessage(response, fallback) };
	return { ok: true, ...((await response.json()) as T) };
}
