// Output-format lines for prompts whose reply becomes the writer's own text.
// Chat-style replies are rendered as Markdown on display, but these land in a
// scene or an entity field, where stray formatting would end up in the work.

// Scene bodies are Markdown, so italics are the one mark prose should carry.
export const PROSE_FORMAT =
	'Format it as manuscript prose: use *asterisks* only for italics, and no bold, headings, lists, or code.';

// Where the model finds the world and the scenes around the work. In the app
// they are assembled into its context; an agent on the MCP endpoint has no
// such context and reads them with the tools. The prompts name the source
// through this, so both surfaces share one instruction text.
export type WorldSource = {
	// Ends a phrase such as "the world and entity details ...".
	where: string;
	// "contradicts what ... about a character".
	establishes: string;
	// "or against ...".
	world: string;
};

export const IN_CONTEXT: WorldSource = {
	where: 'in your context',
	establishes: 'the context establishes',
	world: 'the world context'
};

export const READ_WITH_TOOLS: WorldSource = {
	where: 'as you read them with your tools (get_scene, get_entity, search_text, find_appearances)',
	establishes: 'the entries and scenes you read establish',
	world: 'the entries you read with get_entity and search_text'
};

export const PLAIN_TEXT_FORMAT =
	'Write plain text with no Markdown: no asterisks, headings, lists, or code.';
