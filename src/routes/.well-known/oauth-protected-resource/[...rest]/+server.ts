import type { RequestHandler } from './$types';
import { db } from '#lib/server/db';
import { publicOrigin } from '#lib/server/origin';
import { MCP_PATH } from '#lib/server/mcp/constants';
import { corsPreflight, notFound, oauthJson } from '#lib/server/mcp/http';
import { protectedResourceMetadata } from '#lib/server/mcp/metadata';
import { mcpInstanceEnabled } from '#lib/server/mcp/settings';

// Which authorization server issues tokens for the MCP endpoint (RFC 9728).
// A client looks for it under the endpoint's own path first and at the bare
// address second; both answer the same document.
export const GET: RequestHandler = async ({ url, params }) => {
	if (params.rest !== '' && `/${params.rest}` !== MCP_PATH) return notFound();
	if (!(await mcpInstanceEnabled(db))) return notFound();
	return oauthJson(protectedResourceMetadata(publicOrigin(url)));
};

export const OPTIONS: RequestHandler = () => corsPreflight();
