import { createMcpHandler, fromJsonSchema, McpServer } from '@modelcontextprotocol/server';
import type { Database } from '../auth.ts';
import { logEvent } from '../log.ts';
import type { BearerIdentity } from './oauth.ts';
import { callMcpTool, mcpTools } from './tools.ts';

// The MCP protocol side of the endpoint, on the official SDK. Stateless: a
// server is built for each request from the connection the route resolved,
// and holds nothing afterwards, so there is no session to keep or to steal.

const INSTRUCTIONS =
	"Codex holds a writer's fiction: universes, the stories in them, their chapters and scenes, and entries for characters, places and lore. Start with list_universes, then pass a universe id to the other tools. You cannot change, delete or publish anything. If you were allowed to suggest, your edits and comments wait in the writer's review, and the writer accepts or rejects each one there.";

type Connection = { db: Database; identity: BearerIdentity };

// A tool's argument schema is the same for every request, and compiling its
// validator is the costly part of building a server, so it is done once.
const schemas = new Map<string, ReturnType<typeof fromJsonSchema<Record<string, unknown>>>>();
function schemaFor(name: string, inputSchema: Record<string, unknown>) {
	let schema = schemas.get(name);
	if (!schema) {
		schema = fromJsonSchema<Record<string, unknown>>(inputSchema);
		schemas.set(name, schema);
	}
	return schema;
}

function buildServer(connection: Connection): McpServer {
	const server = new McpServer({ name: 'codex', version: '1' }, { instructions: INSTRUCTIONS });
	for (const tool of mcpTools(connection.identity.permissions)) {
		server.registerTool(
			tool.name,
			{
				description: tool.description,
				inputSchema: schemaFor(tool.name, tool.inputSchema),
				annotations: { readOnlyHint: tool.readOnly, openWorldHint: false }
			},
			async (args) => {
				const result = await callMcpTool(connection.db, connection.identity, tool.name, args);
				return { content: [{ type: 'text', text: result.text }], isError: result.isError };
			}
		);
	}
	return server;
}

// One handler for the process. The route passes the resolved connection with
// each request; the SDK hands it to the factory untouched and never reads a
// credential itself.
const handler = createMcpHandler(
	(context) => buildServer(context.authInfo!.extra!.connection as Connection),
	{ onerror: (error) => logEvent('warn', 'mcp.protocol_error', { message: error.message }) }
);

export function serveMcp(request: Request, connection: Connection): Promise<Response> {
	return handler.fetch(request, {
		authInfo: {
			// The SDK's shape wants these; the tools use the connection only.
			token: '',
			clientId: connection.identity.client.id,
			scopes: connection.identity.permissions,
			extra: { connection }
		}
	});
}
