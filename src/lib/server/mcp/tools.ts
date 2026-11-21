import { isUuid } from '../../slug.ts';
import type { McpPermission } from '../../mcp-access.ts';
import type { Database } from '../auth.ts';
import { logEvent } from '../log.ts';
import { rateLimit } from '../rate-limit.ts';
import { dispatchToolCall, ownsUniverse } from '../llm/tools/dispatch.ts';
import { TOOLS, type ToolDef } from '../llm/tools/registry.ts';
import {
	READ_CALLS_PER_MINUTE,
	READ_CALLS_PER_MINUTE_PER_USER,
	SCENE_BODY_MAX_CHARS,
	TOOL_RESULT_MAX_CHARS
} from './constants.ts';
import type { BearerIdentity } from './oauth.ts';

// The shared toolbox as an outside app sees it. The catalogue and the handlers
// are the Assistant's own (llm/tools); this module only decides which of them
// a connection is offered, turns the universe from something the open page
// supplies into an argument, and checks that universe against the connected
// writer on every call. There is no turn here to check it once for.

export type McpTool = {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	readOnly: boolean;
};

// What a tool needs the connection to have been allowed.
const PERMISSION_FOR: Record<ToolDef['kind'], McpPermission> = { read: 'read', write: 'suggest' };

// The one tool that works without a universe: it is how the others' universe
// ids are found.
const NO_UNIVERSE = new Set(['list_universes']);

const UNIVERSE_ARGUMENT = {
	type: 'string',
	description: 'The id of the universe to work in, from list_universes.'
};

// The same answer whether the universe is missing, in the trash or another
// writer's, so the answer says nothing about what exists.
export const NO_UNIVERSE_RESULT = 'No universe with that id.';

// The tools that exist on this surface today: the read tools. The staging
// tools join when their author kind does.
function offered(tool: ToolDef, permissions: readonly McpPermission[]): boolean {
	return tool.kind === 'read' && !tool.scoped && permissions.includes(PERMISSION_FOR[tool.kind]);
}

function inputSchema(tool: ToolDef): Record<string, unknown> {
	if (NO_UNIVERSE.has(tool.name)) return tool.parameters;
	const parameters = tool.parameters as { properties?: object; required?: string[] };
	return {
		...tool.parameters,
		properties: { universeId: UNIVERSE_ARGUMENT, ...parameters.properties },
		required: ['universeId', ...(parameters.required ?? [])]
	};
}

export function mcpTools(permissions: readonly McpPermission[]): McpTool[] {
	return TOOLS.filter((tool) => offered(tool, permissions)).map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: inputSchema(tool),
		readOnly: tool.kind === 'read'
	}));
}

export type McpToolResult = { text: string; isError: boolean };

// A result that would not fit is cut with a note, so the client does not cut
// it silently somewhere else.
function capped(text: string): string {
	if (text.length <= TOOL_RESULT_MAX_CHARS) return text;
	return `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n...(truncated: showing the first ${TOOL_RESULT_MAX_CHARS} of ${text.length} characters)`;
}

// Runs one tool call for the writer the credential resolved to. Nothing in
// the arguments can name another writer: the user id comes from the identity
// alone, and a universe id is only used once it is known to be theirs.
export async function callMcpTool(
	db: Database,
	identity: BearerIdentity,
	name: string,
	args: Record<string, unknown>
): Promise<McpToolResult> {
	const log = (outcome: string) =>
		logEvent('info', 'mcp.tool', {
			userId: identity.userId,
			grantId: identity.grantId,
			client: identity.client.host,
			tool: name,
			outcome
		});
	const refuse = (outcome: string, text: string): McpToolResult => {
		log(outcome);
		return { text, isError: true };
	};

	const tool = TOOLS.find((entry) => entry.name === name);
	if (!tool || !offered(tool, identity.permissions)) {
		return refuse('unknown_tool', `Unknown tool: ${name}.`);
	}

	const windowMs = 60 * 1000;
	const limits = [
		rateLimit(`mcp:read:grant:${identity.grantId}`, READ_CALLS_PER_MINUTE, windowMs),
		rateLimit(`mcp:read:user:${identity.userId}`, READ_CALLS_PER_MINUTE_PER_USER, windowMs)
	];
	const blocked = limits.find((limit) => !limit.allowed);
	if (blocked) {
		return refuse(
			'rate_limited',
			`Too many calls. Wait ${blocked.retryAfterSeconds} seconds and try again.`
		);
	}

	const { universeId: universeArgument, ...rest } = args;
	let universeId = '';
	if (!NO_UNIVERSE.has(name)) {
		if (
			typeof universeArgument !== 'string' ||
			!isUuid(universeArgument) ||
			!(await ownsUniverse(db, identity.userId, universeArgument))
		) {
			return refuse('no_universe', NO_UNIVERSE_RESULT);
		}
		universeId = universeArgument;
	}

	const outcome = await dispatchToolCall(
		{
			db,
			userId: identity.userId,
			universeId,
			allowedTools: [name],
			external: { sceneBodyCap: SCENE_BODY_MAX_CHARS }
		},
		{ id: 'mcp', name, arguments: JSON.stringify(rest) }
	);
	if (outcome.failed) {
		// The error text stays in the log; it is not prose, and not for the app.
		logEvent('error', 'mcp.tool_failed', {
			tool: name,
			grantId: identity.grantId,
			detail: outcome.result.slice(0, 300)
		});
		return { text: 'The tool failed. Try again.', isError: true };
	}
	log('ok');
	return { text: capped(outcome.result), isError: false };
}
