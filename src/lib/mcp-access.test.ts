import { describe, it, expect } from 'vitest';
import {
	clientDisplayName,
	GRANTABLE_PERMISSIONS,
	parsePermissions,
	permissionsFromScope,
	scopeFromPermissions
} from './mcp-access';
import {
	authorizationServerMetadata,
	mcpResource,
	protectedResourceMetadata,
	protectedResourceUrl
} from './server/mcp/metadata';

describe('permissions', () => {
	it('keeps the known names, in one order, whatever order they arrive in', () => {
		expect(parsePermissions(['suggest', 'bogus', 'read', 'read'])).toEqual(['read', 'suggest']);
		expect(permissionsFromScope('apply  offline_access read')).toEqual(['read', 'apply']);
		expect(permissionsFromScope(null)).toEqual([]);
		expect(scopeFromPermissions(['suggest', 'read'])).toBe('read suggest');
	});

	it('does not offer the apply permission yet', () => {
		expect(GRANTABLE_PERMISSIONS).toEqual(['read', 'suggest']);
	});
});

describe('clientDisplayName', () => {
	it('shows the name with the host that was checked', () => {
		expect(clientDisplayName({ clientName: 'Writing Desk', host: 'app.example' })).toBe(
			'Writing Desk (app.example)'
		);
	});

	it('shows the host alone when the name adds nothing', () => {
		expect(clientDisplayName({ clientName: 'APP.example', host: 'app.example' })).toBe(
			'app.example'
		);
		expect(clientDisplayName({ clientName: '  ', host: 'localhost' })).toBe('localhost');
	});
});

describe('discovery documents', () => {
	const origin = 'https://codex.example';

	it('name the MCP endpoint as the resource and this site as its issuer', () => {
		expect(mcpResource(origin)).toBe('https://codex.example/api/mcp');
		expect(protectedResourceUrl(origin)).toBe(
			'https://codex.example/.well-known/oauth-protected-resource/api/mcp'
		);
		expect(protectedResourceMetadata(origin)).toMatchObject({
			resource: 'https://codex.example/api/mcp',
			authorization_servers: [origin],
			scopes_supported: ['read', 'suggest']
		});
	});

	it('offer both ways for a client to identify itself, public clients and S256 only', () => {
		expect(authorizationServerMetadata(origin)).toMatchObject({
			issuer: origin,
			authorization_endpoint: 'https://codex.example/oauth/authorize',
			token_endpoint: 'https://codex.example/oauth/token',
			registration_endpoint: 'https://codex.example/oauth/register',
			revocation_endpoint: 'https://codex.example/oauth/revoke',
			client_id_metadata_document_supported: true,
			token_endpoint_auth_methods_supported: ['none'],
			code_challenge_methods_supported: ['S256'],
			grant_types_supported: ['authorization_code', 'refresh_token'],
			response_types_supported: ['code']
		});
	});
});
