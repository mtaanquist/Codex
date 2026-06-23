// The Assistant chat's slash commands: shortcuts to the same actions the menu
// offers, typed in the composer. The matcher drives the hint menu; the panel
// owns what each command does.

// Where a command can run: 'story' needs a story focus (and sometimes an open
// scene); 'both' works on a story focus and the universe surface alike. The
// universe Plan panel shows only 'both' commands.
// `args` marks a command that consumes the rest of the line (a brief, a name, a
// query); selecting it from the menu leaves "/name " in the composer to type into
// rather than running it empty.
export type SlashCommand = {
	name: string;
	detail: string;
	scope: 'story' | 'both';
	args?: boolean;
};

export const SLASH_COMMANDS: SlashCommand[] = [
	{
		name: 'write',
		detail: 'Draft a passage from a brief (everything after the command)',
		scope: 'story',
		args: true
	},
	{
		name: 'rewrite',
		detail: 'Rewrite the selected passage to an instruction',
		scope: 'story',
		args: true
	},
	{ name: 'review', detail: 'Review a scene, chapter, or the whole story', scope: 'story' },
	{ name: 'copyedit', detail: 'Run a full review at the current scope', scope: 'story' },
	{
		name: 'continuity-review',
		detail: 'Check for continuity contradictions across the story or universe',
		scope: 'both'
	},
	{ name: 'who', detail: 'Show a character or place sheet', scope: 'both', args: true },
	{ name: 'find', detail: 'Search this universe', scope: 'both', args: true },
	{ name: 'catchup', detail: 'Recap the story so far', scope: 'story' },
	{ name: 'summaries', detail: 'Refresh scene and chapter summaries', scope: 'story' },
	{ name: 'clear', detail: 'Clear this conversation', scope: 'both' },
	{ name: 'help', detail: 'List these commands', scope: 'both' }
];

/** The commands available on a surface: every command on a story, the 'both' set on the universe. */
export function commandsForScope(universe: boolean): SlashCommand[] {
	return universe ? SLASH_COMMANDS.filter((command) => command.scope === 'both') : SLASH_COMMANDS;
}

/**
 * The bare "/word" the composer holds while the hint menu is relevant, or null
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
 * The commands whose names start with the current slash query, narrowed to the
 * surface's scope (the universe surface hides story-only commands).
 */
export function matchSlash(input: string, universe = false): SlashCommand[] {
	const query = slashQuery(input);
	if (query === null) return [];
	return commandsForScope(universe).filter((command) => command.name.startsWith(query));
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
