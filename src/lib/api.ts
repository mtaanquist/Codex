// Shared client-side request helpers. Every endpoint re-checks ownership and
// auth server-side; these just shape the request and hand back either the
// parsed body or a friendly message for the caller to surface.
import { apiErrorMessage } from '#lib/format';

export type Result<T> = ({ ok: true } & T) | { ok: false; message: string };

// A network failure (offline, aborted) resolves to the fallback message like
// any refused request, so callers only ever branch on `ok`. A success with no
// JSON body yields an empty result rather than throwing.
async function send<T>(
	method: string,
	url: string,
	body: BodyInit | undefined,
	headers: HeadersInit | undefined,
	fallback: string
): Promise<Result<T>> {
	let response: Response;
	try {
		response = await fetch(url, { method, headers, body });
	} catch {
		return { ok: false, message: fallback };
	}
	if (!response.ok) return { ok: false, message: await apiErrorMessage(response, fallback) };
	const parsed = (await response.json().catch(() => ({}))) as T;
	return { ok: true, ...parsed };
}

const JSON_HEADERS = { 'content-type': 'application/json' };

/** POSTs JSON and returns the parsed body merged into the result, or a message. */
export function post<T>(url: string, body: unknown, fallback: string): Promise<Result<T>> {
	return send<T>('POST', url, JSON.stringify(body), JSON_HEADERS, fallback);
}

export function put<T>(url: string, body: unknown, fallback: string): Promise<Result<T>> {
	return send<T>('PUT', url, JSON.stringify(body), JSON_HEADERS, fallback);
}

export function patch<T>(url: string, body: unknown, fallback: string): Promise<Result<T>> {
	return send<T>('PATCH', url, JSON.stringify(body), JSON_HEADERS, fallback);
}

export function del<T>(url: string, fallback: string): Promise<Result<T>> {
	return send<T>('DELETE', url, undefined, undefined, fallback);
}

/** POSTs a multipart form (a file upload); the browser sets the content type. */
export function upload<T>(url: string, form: FormData, fallback: string): Promise<Result<T>> {
	return send<T>('POST', url, form, undefined, fallback);
}
