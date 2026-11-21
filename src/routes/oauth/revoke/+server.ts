import type { RequestHandler } from './$types';
import { db } from '#lib/server/db';
import { rateLimit } from '#lib/server/rate-limit';
import { TOKEN_PER_MINUTE } from '#lib/server/mcp/constants';
import { corsPreflight, notFound, oauthJson, tooManyRequests } from '#lib/server/mcp/http';
import { revokeToken } from '#lib/server/mcp/oauth';
import { mcpInstanceEnabled } from '#lib/server/mcp/settings';

// Token revocation (RFC 7009): an app hands back a token when the writer
// disconnects it on the app's side. Holding the token is the proof; the answer
// is the same whether or not the token was known.
export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	if (!(await mcpInstanceEnabled(db))) return notFound();
	const limit = rateLimit(`oauth:revoke:${getClientAddress()}`, TOKEN_PER_MINUTE, 60 * 1000);
	if (!limit.allowed) return tooManyRequests(limit.retryAfterSeconds);

	const token = new URLSearchParams(await request.text()).get('token');
	if (token) await revokeToken(db, token);
	return oauthJson({});
};

export const OPTIONS: RequestHandler = () => corsPreflight();
