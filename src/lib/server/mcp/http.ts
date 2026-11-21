// Response shapes shared by the OAuth endpoints. These routes are called by
// other programs, some of them running in a browser on another site, and none
// of them reads the session cookie, so any origin may read the answers.

const CORS = {
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'GET, POST, OPTIONS',
	'access-control-allow-headers': 'content-type, authorization, mcp-protocol-version',
	'access-control-max-age': '86400'
};

export function oauthJson(body: unknown, status = 200, headers: Record<string, string> = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'content-type': 'application/json',
			'cache-control': 'no-store',
			...CORS,
			...headers
		}
	});
}

// RFC 6749 5.2.
export function oauthError(status: number, error: string, description: string): Response {
	return oauthJson({ error, error_description: description }, status);
}

export function corsPreflight(): Response {
	return new Response(null, { status: 204, headers: CORS });
}

// With external access turned off for the instance, the routes do not exist.
export function notFound(): Response {
	return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
}

export function tooManyRequests(retryAfterSeconds: number): Response {
	return oauthJson(
		{ error: 'temporarily_unavailable', error_description: 'Too many requests. Try again later.' },
		429,
		{ 'retry-after': String(retryAfterSeconds) }
	);
}
