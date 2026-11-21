import { isUuid } from '../../slug.ts';
import type { McpPermission } from '../../mcp-access.ts';
import type { Database } from '../auth.ts';
import { logEvent } from '../log.ts';
import { rateLimit } from '../rate-limit.ts';
import { dispatchToolCall, ownsUniverse } from '../llm/tools/dispatch.ts';
import { TOOLS, type ToolDef } from '../llm/tools/registry.ts';
import {
	MAX_NOTES_WAITING_PER_SCENE,
	READ_CALLS_PER_MINUTE,
	READ_CALLS_PER_MINUTE_PER_USER,
	SCENE_BODY_MAX_CHARS,
	STAGING_CALLS_PER_MINUTE,
	STAGING_CALLS_PER_MINUTE_PER_USER,
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

// Arguments a tool takes on this surface only. In the app the open page (or
// the run that called the tool) fixes the thread, the suggestion, the pattern
// note and the edit being followed up. An app has no page, so it names them;
// the dispatcher checks each against the connected writer and the app's own
// notes (reachableStory, appEditLink).
type ExtraArgument = { name: string; description: string; required: boolean };
const EXTRA_ARGUMENTS: Record<string, ExtraArgument[]> = {
	reply_in_thread: [
		{
			name: 'threadId',
			description:
				'The id of the review thread to reply in: a note of yours, or the threadId of one of your edits from get_review_note. You can reply once the writer has written there, and then wait for them again.',
			required: true
		}
	],
	update_suggestion: [
		{
			name: 'suggestionId',
			description:
				'The id of your own pending suggestion to revise. Revise only after the writer has answered in its discussion (see get_review_note).',
			required: true
		}
	],
	suggest_edit: [
		{
			name: 'patternNoteId',
			description:
				'Optional: the id of a pattern note of yours to add this edit to, so the writer meets it when working through that note.',
			required: false
		},
		{
			name: 'followsSuggestionId',
			description:
				'Optional: the id of an accepted edit in a pattern note of yours, when this edit fixes something that change left awkward. The edit must then sit in the changed paragraph or the one before or after it, and each accepted edit takes one follow-up.',
			required: false
		}
	]
};

// The tools a connection is offered: every read tool, and the staging tools
// when the writer allowed suggestions.
function offered(tool: ToolDef, permissions: readonly McpPermission[]): boolean {
	return permissions.includes(PERMISSION_FOR[tool.kind]);
}

function inputSchema(tool: ToolDef): Record<string, unknown> {
	if (NO_UNIVERSE.has(tool.name)) return tool.parameters;
	const parameters = tool.parameters as { properties?: object; required?: string[] };
	const extras = EXTRA_ARGUMENTS[tool.name] ?? [];
	return {
		...tool.parameters,
		properties: {
			universeId: UNIVERSE_ARGUMENT,
			...parameters.properties,
			...Object.fromEntries(
				extras.map((extra) => [extra.name, { type: 'string', description: extra.description }])
			)
		},
		required: [
			'universeId',
			...extras.filter((extra) => extra.required).map((extra) => extra.name),
			...(parameters.required ?? [])
		]
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
	args: Record<string, unknown>,
	// Where this Codex is reached, for links in results.
	origin: string
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

	// Staging has its own, tighter budget, so a burst of reads cannot be spent
	// on notes and a burst of notes does not stop the app reading.
	const windowMs = 60 * 1000;
	const staging = tool.kind === 'write';
	const perGrant = staging ? STAGING_CALLS_PER_MINUTE : READ_CALLS_PER_MINUTE;
	const perUser = staging ? STAGING_CALLS_PER_MINUTE_PER_USER : READ_CALLS_PER_MINUTE_PER_USER;
	const limits = [
		rateLimit(`mcp:${tool.kind}:grant:${identity.grantId}`, perGrant, windowMs),
		rateLimit(`mcp:${tool.kind}:user:${identity.userId}`, perUser, windowMs)
	];
	const blocked = limits.find((limit) => !limit.allowed);
	if (blocked) {
		return refuse(
			'rate_limited',
			`Too many calls. Wait ${blocked.retryAfterSeconds} seconds and try again.`
		);
	}

	// What the app is told when a call fails, whatever failed. The log names
	// the tool and the database's error code and nothing else: a database
	// error's message is the statement and the values bound to it, which are
	// the writer's prose.
	const failed = (code: string | undefined): McpToolResult => {
		logEvent('error', 'mcp.tool_failed', { tool: name, grantId: identity.grantId, code });
		return { text: 'The tool failed. Try again.', isError: true };
	};

	try {
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
				external: {
					sceneBodyCap: SCENE_BODY_MAX_CHARS,
					client: {
						id: identity.client.id,
						name: identity.client.clientName,
						host: identity.client.host
					},
					maxNotesPerScene: MAX_NOTES_WAITING_PER_SCENE,
					origin
				}
			},
			{ id: 'mcp', name, arguments: JSON.stringify(rest) }
		);
		if (outcome.failed) return failed(outcome.errorCode);
		log(outcome.staged ? 'staged' : 'ok');
		return { text: capped(outcome.result), isError: false };
	} catch (err) {
		// The dispatcher catches what its handlers throw; this is for anything
		// outside it, so no error's own text ever reaches the app.
		const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
		return failed(typeof code === 'string' ? code : undefined);
	}
}
