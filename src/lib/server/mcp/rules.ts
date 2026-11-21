import { createHash, timingSafeEqual } from 'node:crypto';
import { MAX_CLIENT_NAME, MAX_REDIRECT_URIS, MAX_URI_LENGTH } from './constants.ts';

// The OAuth rules that need no database: which redirect URIs are acceptable,
// how a requested one is matched against a registration, PKCE, and what a
// client's metadata must say. Kept pure so each rule has a unit test.

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function parseUrl(value: unknown): URL | null {
	if (typeof value !== 'string' || value.length > MAX_URI_LENGTH) return null;
	try {
		return new URL(value);
	} catch {
		return null;
	}
}

export function isLoopbackRedirect(uri: string): boolean {
	const url = parseUrl(uri);
	return url !== null && url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

// A redirect URI is where the browser is sent with the code, so only two
// shapes are accepted: https anywhere, and plain http on this computer (a
// desktop app listening on a local port). No fragment and no credentials.
export function validRedirectUri(uri: unknown): uri is string {
	const url = parseUrl(uri);
	if (!url || url.hash || url.username || url.password) return false;
	if (url.protocol === 'https:') return true;
	return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

// The host shown beside an app's name. For a local app the port is noise.
export function redirectHost(uri: string): string {
	const url = new URL(uri);
	return isLoopbackRedirect(uri) ? url.hostname : url.host;
}

function withoutPort(uri: string): string {
	const url = new URL(uri);
	url.port = '';
	return url.toString();
}

// A requested redirect URI must be one the client registered, character for
// character. The one exception is a local app: it picks a free port each time
// it runs, so for http on this computer the port is ignored (RFC 8252 7.3).
export function redirectMatches(registered: readonly string[], requested: string): boolean {
	if (!validRedirectUri(requested)) return false;
	if (registered.includes(requested)) return true;
	if (!isLoopbackRedirect(requested)) return false;
	const wanted = withoutPort(requested);
	return registered.some((uri) => isLoopbackRedirect(uri) && withoutPort(uri) === wanted);
}

const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

// An S256 challenge is the base64url SHA-256 of the verifier: always 43 chars.
export function validCodeChallenge(challenge: unknown): challenge is string {
	return typeof challenge === 'string' && CHALLENGE_RE.test(challenge);
}

export function verifyPkce(verifier: unknown, challenge: string): boolean {
	if (typeof verifier !== 'string' || !VERIFIER_RE.test(verifier)) return false;
	const computed = createHash('sha256').update(verifier).digest('base64url');
	const a = Buffer.from(computed);
	const b = Buffer.from(challenge);
	return a.length === b.length && timingSafeEqual(a, b);
}

// A client that identifies itself with a metadata document uses the
// document's https URL as its client_id. The URL must have a path, so a bare
// site address cannot stand in for one.
export function isClientIdUrl(clientId: string): boolean {
	const url = parseUrl(clientId);
	return (
		url !== null &&
		url.protocol === 'https:' &&
		!url.hash &&
		!url.username &&
		!url.password &&
		url.pathname !== '/' &&
		!url.pathname.split('/').some((segment) => segment === '.' || segment === '..')
	);
}

export type ClientMetadata = { clientName: string | null; redirectUris: string[] };
export type MetadataResult =
	| { ok: true; metadata: ClientMetadata }
	| { ok: false; error: 'invalid_redirect_uri' | 'invalid_client_metadata'; description: string };

// What a registration request or a metadata document must say. Only public
// clients using the authorization code flow are accepted.
export function parseClientMetadata(input: unknown): MetadataResult {
	const bad = (description: string): MetadataResult => ({
		ok: false,
		error: 'invalid_client_metadata',
		description
	});
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		return bad('The client metadata must be a JSON object.');
	}
	const doc = input as Record<string, unknown>;

	const uris = doc.redirect_uris;
	if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
		return {
			ok: false,
			error: 'invalid_redirect_uri',
			description: `redirect_uris must list between 1 and ${MAX_REDIRECT_URIS} addresses.`
		};
	}
	if (!uris.every(validRedirectUri)) {
		return {
			ok: false,
			error: 'invalid_redirect_uri',
			description:
				'Each redirect URI must be an https address, or an http address on localhost, with no fragment.'
		};
	}

	// One client, one remote place the code can go. The host is what the
	// writer is shown beside the app's name, so a list spanning remote hosts
	// would let a client show one and be answered at another. Local addresses
	// (any loopback name, any port) may sit beside the one remote host, since
	// desktop apps register both; the consent page names whichever is in use.
	const remoteHosts = new Set(
		(uris as string[]).filter((uri) => !isLoopbackRedirect(uri)).map((uri) => new URL(uri).host)
	);
	if (remoteHosts.size > 1) {
		return {
			ok: false,
			error: 'invalid_redirect_uri',
			description:
				'The https redirect URIs must all be on one host. Register a separate client for each host.'
		};
	}

	const method = doc.token_endpoint_auth_method;
	if (method !== undefined && method !== 'none') {
		return bad('Only public clients are supported: token_endpoint_auth_method must be "none".');
	}
	const grants = doc.grant_types;
	if (grants !== undefined && !(Array.isArray(grants) && grants.includes('authorization_code'))) {
		return bad('grant_types must include "authorization_code".');
	}
	const responses = doc.response_types;
	if (responses !== undefined && !(Array.isArray(responses) && responses.includes('code'))) {
		return bad('response_types must include "code".');
	}

	const name = typeof doc.client_name === 'string' ? doc.client_name.trim() : '';
	return {
		ok: true,
		metadata: {
			// Control characters would let a name break out of the line it is
			// shown on; format characters (direction overrides, zero-width marks)
			// would let it read as something it is not.
			clientName:
				name
					.replace(/\p{Cc}/gu, ' ')
					.replace(/\p{Cf}/gu, '')
					.trim()
					.slice(0, MAX_CLIENT_NAME) || null,
			redirectUris: [...new Set(uris as string[])]
		}
	};
}
