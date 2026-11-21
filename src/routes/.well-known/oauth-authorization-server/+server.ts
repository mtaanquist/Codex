import type { RequestHandler } from './$types';
import { db } from '#lib/server/db';
import { publicOrigin } from '#lib/server/origin';
import { corsPreflight, notFound, oauthJson } from '#lib/server/mcp/http';
import { authorizationServerMetadata } from '#lib/server/mcp/metadata';
import { mcpInstanceEnabled } from '#lib/server/mcp/settings';

// Where an outside app learns how to ask a writer for access (RFC 8414).
export const GET: RequestHandler = async ({ url }) => {
	if (!(await mcpInstanceEnabled(db))) return notFound();
	return oauthJson(authorizationServerMetadata(publicOrigin(url)));
};

export const OPTIONS: RequestHandler = () => corsPreflight();
