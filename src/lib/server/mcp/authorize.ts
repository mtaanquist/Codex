import type { Database } from '../auth.ts';
import {
	BASE_PERMISSION,
	GRANTABLE_PERMISSIONS,
	permissionsFromScope,
	type McpPermission
} from '../../mcp-access.ts';
import { findClient, type FetchClientDocument, type OauthClient } from './clients.ts';
import { mcpResource } from './metadata.ts';
import { redirectHost, redirectMatches, validCodeChallenge } from './rules.ts';

// Checks an authorization request: the address an outside app sends a writer
// to. The same check runs when the consent page is shown and again when the
// writer answers it, from the same fields, so nothing can change in between.

// The request's fields, carried from the query into the consent form.
export const AUTHORIZE_FIELDS = [
	'response_type',
	'client_id',
	'redirect_uri',
	'code_challenge',
	'code_challenge_method',
	'state',
	'scope',
	'resource'
] as const;

export type AuthorizeCheck =
	// The client or its redirect address cannot be trusted, so the writer is
	// told here and nobody is sent anywhere.
	| { kind: 'invalid'; message: string }
	// The client is known but the request is wrong. `location` is its own
	// redirect address with the error in the query; the writer is shown the
	// fault with a link there (`host` names it). Nobody is sent on without a
	// click: a client registers itself, so an automatic redirect would make
	// this page forward visitors to any address.
	| { kind: 'refused'; location: string; host: string }
	| {
			kind: 'ok';
			client: OauthClient;
			redirectUri: string;
			state: string | null;
			codeChallenge: string;
			// What the writer may tick, and what starts ticked.
			offered: McpPermission[];
			requested: McpPermission[];
	  };

// The address to send the browser back to, with the answer in its query. iss
// names this server so the app can tell whose answer it is (RFC 9207).
export function clientRedirect(
	redirectUri: string,
	origin: string,
	params: Record<string, string | null>
): string {
	const url = new URL(redirectUri);
	for (const [key, value] of Object.entries(params)) {
		if (value !== null) url.searchParams.set(key, value);
	}
	url.searchParams.set('iss', origin);
	return url.toString();
}

export async function checkAuthorizeRequest(
	db: Database,
	field: (name: (typeof AUTHORIZE_FIELDS)[number]) => string | null,
	origin: string,
	fetchDocument?: FetchClientDocument
): Promise<AuthorizeCheck> {
	const clientId = field('client_id') ?? '';
	const redirectUri = field('redirect_uri') ?? '';
	const client = await findClient(db, clientId, fetchDocument);
	if (!client) {
		return {
			kind: 'invalid',
			message:
				'Codex does not recognise the app that sent you here. Go back to the app and try connecting again.'
		};
	}
	if (!redirectMatches(client.redirectUris, redirectUri)) {
		return {
			kind: 'invalid',
			message:
				'The app that sent you here asked to be answered at an address it has not registered. Nothing was shared with it.'
		};
	}

	const state = field('state');
	const refuse = (error: string, description: string): AuthorizeCheck => ({
		kind: 'refused',
		location: clientRedirect(redirectUri, origin, {
			error,
			error_description: description,
			state
		}),
		host: redirectHost(redirectUri)
	});
	if (field('response_type') !== 'code') {
		return refuse('unsupported_response_type', 'response_type must be "code".');
	}
	const codeChallenge = field('code_challenge');
	if (field('code_challenge_method') !== 'S256' || !validCodeChallenge(codeChallenge)) {
		return refuse('invalid_request', 'A PKCE code_challenge with method S256 is required.');
	}
	const resource = field('resource');
	if (resource !== null && resource !== '' && resource !== mcpResource(origin)) {
		return refuse('invalid_target', 'The resource must be the address of this MCP endpoint.');
	}

	// Unknown scope names are ignored, not refused: apps ask for scopes such as
	// offline_access as a matter of course. An app that names none we know is
	// offered everything a writer can grant.
	const asked = permissionsFromScope(field('scope')).filter((permission) =>
		GRANTABLE_PERMISSIONS.includes(permission)
	);
	const wanted = asked.length > 0 ? asked : [...GRANTABLE_PERMISSIONS];
	const requested = GRANTABLE_PERMISSIONS.filter(
		(permission) => permission === BASE_PERMISSION || wanted.includes(permission)
	);
	return {
		kind: 'ok',
		client,
		redirectUri,
		state,
		codeChallenge,
		offered: [...GRANTABLE_PERMISSIONS],
		requested
	};
}

// What the writer ticked, held to what was offered. Reading is always in.
export function chosenPermissions(
	offered: readonly McpPermission[],
	ticked: readonly string[]
): McpPermission[] {
	return offered.filter(
		(permission) => permission === BASE_PERMISSION || ticked.includes(permission)
	);
}
