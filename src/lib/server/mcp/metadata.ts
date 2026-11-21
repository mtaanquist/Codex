import { GRANTABLE_PERMISSIONS } from '../../mcp-access.ts';
import { MCP_PATH } from './constants.ts';

// The two discovery documents a client reads before it can ask for access,
// and the addresses they point at. Everything hangs off the site origin, which
// is also the issuer.

export const OAUTH_PATHS = {
	authorize: '/oauth/authorize',
	token: '/oauth/token',
	register: '/oauth/register',
	revoke: '/oauth/revoke',
	authorizationServer: '/.well-known/oauth-authorization-server',
	protectedResource: '/.well-known/oauth-protected-resource'
} as const;

// The resource the tokens are for: the MCP endpoint's full address, exactly as
// a writer types it into their app.
export function mcpResource(origin: string): string {
	return origin + MCP_PATH;
}

// Where the protected resource document lives; goes in the 401 challenge.
export function protectedResourceUrl(origin: string): string {
	return origin + OAUTH_PATHS.protectedResource + MCP_PATH;
}

// RFC 9728.
export function protectedResourceMetadata(origin: string) {
	return {
		resource: mcpResource(origin),
		authorization_servers: [origin],
		scopes_supported: [...GRANTABLE_PERMISSIONS],
		bearer_methods_supported: ['header'],
		resource_name: 'Codex'
	};
}

// RFC 8414. A client picks how to identify itself from this: a metadata
// document (client_id_metadata_document_supported with the "none" auth method)
// or registration (registration_endpoint). Both are offered.
export function authorizationServerMetadata(origin: string) {
	return {
		issuer: origin,
		authorization_endpoint: origin + OAUTH_PATHS.authorize,
		token_endpoint: origin + OAUTH_PATHS.token,
		registration_endpoint: origin + OAUTH_PATHS.register,
		revocation_endpoint: origin + OAUTH_PATHS.revoke,
		scopes_supported: [...GRANTABLE_PERMISSIONS],
		response_types_supported: ['code'],
		response_modes_supported: ['query'],
		grant_types_supported: ['authorization_code', 'refresh_token'],
		token_endpoint_auth_methods_supported: ['none'],
		revocation_endpoint_auth_methods_supported: ['none'],
		code_challenge_methods_supported: ['S256'],
		client_id_metadata_document_supported: true,
		authorization_response_iss_parameter_supported: true
	};
}
