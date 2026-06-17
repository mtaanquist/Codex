// The Assistant chat's slash commands: shortcuts to the same actions the menu
// offers, typed in the composer. The matcher drives the hint menu; the panel
// owns what each command does.

export type SlashCommand = { name: string; detail: string };

export const SLASH_COMMANDS: SlashCommand[] = [
	{ name: 'review', detail: 'Review a scene, chapter, or the whole story' },
	{ name: 'catchup', detail: 'Recap the story so far' },
	{ name: 'summaries', detail: 'Refresh scene and chapter summaries' },
	{ name: 'clear', detail: 'Clear this conversation' },
	{ name: 'help', detail: 'List these commands' }
];

/**
 * The bare "/word" the composer holds while the hint menu is relevant, or null
 * when the input is not a single-line slash query (empty, multi-line, or no
 * leading slash).
 */
export function slashQuery(input: string): string | null {
	return input.startsWith('/') && !input.includes('\n')
		? input.slice(1).split(/\s+/)[0].toLowerCase()
		: null;
}

/** The commands whose names start with the current slash query. */
export function matchSlash(input: string): SlashCommand[] {
	const query = slashQuery(input);
	return query === null ? [] : SLASH_COMMANDS.filter((command) => command.name.startsWith(query));
}

/** The command name from a typed "/name ..." line, lower-cased. */
export function slashName(raw: string): string {
	return raw.slice(1).split(/\s+/)[0].toLowerCase();
}
