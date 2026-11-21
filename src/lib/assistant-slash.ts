// The Assistant chat's actions: one list for the command menu (the "/" button
// in the composer) and for commands typed as "/name". The matcher drives the
// menu; the panel owns what each action does.

// Where an action can run: 'story' needs a story focus (and sometimes an open
// scene); 'both' works on a story focus and the universe surface alike. The
// universe Plan panel shows only 'both' actions.
// `args` marks a command that consumes the rest of the line (a brief, a name, a
// query); choosing it from the menu leaves "/name " in the composer to type into
// rather than running it empty.
export type ActionGroup = 'context' | 'chat' | 'write' | 'review' | 'lookup' | 'upkeep' | 'model';

export type SlashCommand = {
	name: string;
	label: string;
	detail: string;
	group: ActionGroup;
	scope: 'story' | 'both';
	args?: boolean;
};

// The menu's sections, in the order they show.
export const ACTION_GROUPS: { id: ActionGroup; label: string }[] = [
	{ id: 'context', label: 'Context' },
	// Ahead of Chat, so "/m" and Enter switch the model rather than mute.
	{ id: 'model', label: 'Model' },
	{ id: 'chat', label: 'Chat' },
	{ id: 'write', label: 'Write' },
	{ id: 'review', label: 'Review' },
	{ id: 'lookup', label: 'Look up' },
	{ id: 'upkeep', label: 'Upkeep' }
];

// Listed in ACTION_GROUPS order, so a filtered list keeps its sections together.
export const SLASH_COMMANDS: SlashCommand[] = [
	{
		name: 'context',
		label: 'Add context',
		detail: 'Add a scene, chapter, character, note or story to your next message',
		group: 'context',
		scope: 'both'
	},
	{
		name: 'model',
		label: 'Switch model',
		detail: 'Pick the model and effort for this chat',
		group: 'model',
		scope: 'both'
	},
	{
		name: 'new',
		label: 'New chat',
		detail: 'Start a new chat (this one stays in your chat list)',
		group: 'chat',
		scope: 'both'
	},
	{
		name: 'history',
		label: 'Chat history',
		detail: 'Open one of your earlier chats',
		group: 'chat',
		scope: 'both'
	},
	{
		name: 'delete',
		label: 'Delete chat',
		detail: 'Delete this chat for good',
		group: 'chat',
		scope: 'both'
	},
	{
		name: 'mute',
		label: 'Mute for this story',
		detail: 'Hide the Assistant for this story',
		group: 'chat',
		scope: 'story'
	},
	{
		name: 'help',
		label: 'List commands',
		detail: 'List these commands',
		group: 'chat',
		scope: 'both'
	},
	{
		name: 'write',
		label: 'Write a passage',
		detail: 'Write a passage from a brief (everything after the command)',
		group: 'write',
		scope: 'story',
		args: true
	},
	{
		name: 'draft',
		label: 'Draft this scene',
		detail: 'Draft the whole open scene from a brief (everything after the command)',
		group: 'write',
		scope: 'story',
		args: true
	},
	{
		name: 'draft-chapter',
		label: 'Draft this chapter',
		detail: "Draft the scenes you choose in the open scene's chapter, one by one, from a brief",
		group: 'write',
		scope: 'story',
		args: true
	},
	{
		name: 'rewrite',
		label: 'Rewrite the selection',
		detail: 'Rewrite the selected passage to an instruction',
		group: 'write',
		scope: 'story',
		args: true
	},
	{
		name: 'review',
		label: 'Review',
		detail: 'Review a scene, chapter, or the whole story',
		group: 'review',
		scope: 'story'
	},
	{
		name: 'copyedit',
		label: 'Copyedit',
		detail: 'Run a full review at the current scope',
		group: 'review',
		scope: 'story'
	},
	{
		name: 'continuity-review',
		label: 'Continuity review',
		detail: 'Check for continuity contradictions across the story or universe',
		group: 'review',
		scope: 'both'
	},
	{
		name: 'who',
		label: 'Character or place sheet',
		detail: 'Show a character or place sheet',
		group: 'lookup',
		scope: 'both',
		args: true
	},
	{
		name: 'find',
		label: 'Search this universe',
		detail: 'Search this universe',
		group: 'lookup',
		scope: 'both',
		args: true
	},
	{
		name: 'catchup',
		label: 'Catch me up',
		detail: 'Recap the story so far',
		group: 'lookup',
		scope: 'story'
	},
	{
		name: 'summaries',
		label: 'Update summaries',
		detail: 'Draft and refresh scene and chapter summaries in the background',
		group: 'upkeep',
		scope: 'story'
	},
	{
		name: 'enrich',
		label: 'Enrich entries',
		detail: 'Suggest aliases and details for every entry in this universe',
		group: 'upkeep',
		scope: 'both'
	}
];

// What /who and /find send to the model. Kept here so the chat panel and the
// prompts an outside app is offered (#lib/server/mcp/prompts) ask the same.
export function whoAsk(who: string): string {
	return `Show me a short sheet for ${who}: the key facts you have on them.`;
}

export function findAsk(query: string): string {
	return `Search this universe for "${query}" and list what you find, with where each turns up.`;
}

/** The commands available on a surface: every command on a story, the 'both' set on the universe. */
export function commandsForScope(universe: boolean): SlashCommand[] {
	return universe ? SLASH_COMMANDS.filter((command) => command.scope === 'both') : SLASH_COMMANDS;
}

/**
 * The bare "/word" the composer holds while the menu is relevant, or null
 * when the input is not a single-line slash query. Returns null once a space is
 * typed: the command is chosen and the rest of the line is its arguments, so the
 * menu gets out of the way.
 */
export function slashQuery(input: string): string | null {
	return input.startsWith('/') && !input.includes('\n') && !input.includes(' ')
		? input.slice(1).toLowerCase()
		: null;
}

/**
 * The commands a menu query matches: a command whose name starts with the
 * query, or whose label has a word that does. The command named exactly comes
 * first, then the other names the query starts, then the label matches, each
 * in menu order, so Enter on a typed name runs that command. A single letter
 * names nothing yet, so its matches stay in menu order: Enter after one
 * letter must not jump to a command that starts work at once ("/s" is the
 * model switch, not a summaries run). An empty query matches every command
 * on the surface.
 */
export function matchCommands(query: string, universe = false): SlashCommand[] {
	const q = query.trim().toLowerCase().replace(/^\//, '');
	const scoped = commandsForScope(universe);
	if (!q) return scoped;
	const labelled = (command: SlashCommand) =>
		command.label
			.toLowerCase()
			.split(/\s+/)
			.some((word) => word.startsWith(q));
	if (q.length === 1) {
		return scoped.filter((command) => command.name.startsWith(q) || labelled(command));
	}
	const exact = scoped.filter((command) => command.name === q);
	const byName = scoped.filter((command) => command.name !== q && command.name.startsWith(q));
	const byLabel = scoped.filter((command) => !command.name.startsWith(q) && labelled(command));
	return [...exact, ...byName, ...byLabel];
}

// Older names the panel still runs, kept out of the menu.
const SLASH_ALIASES = ['clear', 'catch-up'];

/** True when a typed "/name ..." line names a command the panel can run. */
export function isSlashCommand(raw: string): boolean {
	const name = slashName(raw);
	return SLASH_COMMANDS.some((command) => command.name === name) || SLASH_ALIASES.includes(name);
}

/**
 * True when a typed line gives words to a command that takes none ("/help me
 * with this"): it is more likely a message than a command, so the panel keeps it.
 */
export function hasStrayArgs(raw: string): boolean {
	if (slashArgs(raw) === '') return false;
	const name = slashName(raw);
	if (SLASH_ALIASES.includes(name)) return true;
	return !SLASH_COMMANDS.find((command) => command.name === name)?.args;
}

/** The commands the composer's "/word" matches; empty when it holds no slash query. */
export function matchSlash(input: string, universe = false): SlashCommand[] {
	const query = slashQuery(input);
	return query === null ? [] : matchCommands(query, universe);
}

/** The command name from a typed "/name ..." line, lower-cased. */
export function slashName(raw: string): string {
	return raw.slice(1).split(/\s+/)[0].toLowerCase();
}

/** Everything after the first token of a "/name args" line, trimmed; "" when there are none. */
export function slashArgs(raw: string): string {
	const space = raw.search(/\s/);
	return space === -1 ? '' : raw.slice(space + 1).trim();
}
