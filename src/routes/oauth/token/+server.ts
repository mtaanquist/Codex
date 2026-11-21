import type { RequestHandler } from './$types';
import { db } from '#lib/server/db';
import { logEvent } from '#lib/server/log';
import { publicOrigin } from '#lib/server/origin';
import { rateLimit } from '#lib/server/rate-limit';
import { scopeFromPermissions } from '#lib/mcp-access';
import { TOKEN_PER_MINUTE } from '#lib/server/mcp/constants';
import {
	corsPreflight,
	notFound,
	oauthError,
	oauthJson,
	tooManyRequests
} from '#lib/server/mcp/http';
import { mcpResource } from '#lib/server/mcp/metadata';
import { exchangeCode, refreshTokens, type TokenResult } from '#lib/server/mcp/oauth';
import { mcpInstanceEnabled } from '#lib/server/mcp/settings';

// The token endpoint (RFC 6749 with PKCE): a code for tokens, or a refresh
// token for a new pair. Called by the app itself, never by a browser form on
// this site, so it reads no cookie and is left out of the cross-site form
// check (see #lib/server/csrf).
export const POST: RequestHandler = async ({ request, url, getClientAddress }) => {
	if (!(await mcpInstanceEnabled(db))) return notFound();
	const limit = rateLimit(`oauth:token:${getClientAddress()}`, TOKEN_PER_MINUTE, 60 * 1000);
	if (!limit.allowed) return tooManyRequests(limit.retryAfterSeconds);

	const type = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
	if (type !== 'application/x-www-form-urlencoded') {
		return oauthError(400, 'invalid_request', 'Send the request as a form.');
	}
	const form = new URLSearchParams(await request.text());
	const field = (name: string) => form.get(name) ?? '';

	// A client that names the resource must mean this one (RFC 8707).
	const resource = form.get('resource');
	if (resource !== null && resource !== mcpResource(publicOrigin(url))) {
		return oauthError(400, 'invalid_target', 'These tokens are only for this Codex.');
	}

	const grantType = field('grant_type');
	let result: TokenResult;
	if (grantType === 'authorization_code') {
		if (
			!field('code') ||
			!field('client_id') ||
			!field('redirect_uri') ||
			!field('code_verifier')
		) {
			return oauthError(
				400,
				'invalid_request',
				'code, client_id, redirect_uri and code_verifier are required.'
			);
		}
		result = await exchangeCode(db, {
			code: field('code'),
			clientId: field('client_id'),
			redirectUri: field('redirect_uri'),
			codeVerifier: field('code_verifier')
		});
	} else if (grantType === 'refresh_token') {
		if (!field('refresh_token') || !field('client_id')) {
			return oauthError(400, 'invalid_request', 'refresh_token and client_id are required.');
		}
		result = await refreshTokens(db, {
			refreshToken: field('refresh_token'),
			clientId: field('client_id')
		});
	} else {
		return oauthError(400, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
	}

	if (!result.ok) {
		logEvent('info', 'oauth.token_refused', { grantType });
		return oauthError(400, 'invalid_grant', 'The code or token is not valid any more.');
	}
	const { tokens } = result;
	return oauthJson({
		access_token: tokens.accessToken,
		token_type: 'Bearer',
		expires_in: tokens.expiresInSeconds,
		refresh_token: tokens.refreshToken,
		scope: scopeFromPermissions(tokens.permissions)
	});
};

export const OPTIONS: RequestHandler = () => corsPreflight();
