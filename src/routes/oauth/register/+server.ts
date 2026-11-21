import type { RequestHandler } from './$types';
import { db } from '#lib/server/db';
import { logEvent } from '#lib/server/log';
import { rateLimit } from '#lib/server/rate-limit';
import { registerClient } from '#lib/server/mcp/clients';
import { REGISTER_PER_HOUR } from '#lib/server/mcp/constants';
import {
	corsPreflight,
	notFound,
	oauthError,
	oauthJson,
	tooManyRequests
} from '#lib/server/mcp/http';
import { mcpInstanceEnabled } from '#lib/server/mcp/settings';

const MAX_BODY_CHARS = 16 * 1024;

// Dynamic client registration (RFC 7591): an app introduces itself and gets a
// client_id. Anyone can call this, so it is rate limited, takes a small body,
// and what it creates can do nothing until a writer allows it.
export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	if (!(await mcpInstanceEnabled(db))) return notFound();
	const limit = rateLimit(`oauth:register:${getClientAddress()}`, REGISTER_PER_HOUR, 3600 * 1000);
	if (!limit.allowed) return tooManyRequests(limit.retryAfterSeconds);

	let body: unknown;
	try {
		const text = await request.text();
		if (text.length > MAX_BODY_CHARS) throw new Error('too large');
		body = JSON.parse(text);
	} catch {
		return oauthError(400, 'invalid_client_metadata', 'Send the client metadata as a JSON object.');
	}

	const result = await registerClient(db, body);
	if (!result.ok) return oauthError(400, result.error, result.description);
	const { client } = result;
	logEvent('info', 'oauth.client_registered', { clientId: client.clientId, host: client.host });
	return oauthJson(
		{
			client_id: client.clientId,
			client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
			client_name: client.clientName,
			redirect_uris: client.redirectUris,
			token_endpoint_auth_method: 'none',
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code']
		},
		201
	);
};

export const OPTIONS: RequestHandler = () => corsPreflight();
