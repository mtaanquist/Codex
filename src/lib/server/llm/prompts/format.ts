// Output-format lines for prompts whose reply becomes the writer's own text.
// Chat-style replies are rendered as Markdown on display, but these land in a
// scene or an entity field, where stray formatting would end up in the work.

// Scene bodies are Markdown, so italics are the one mark prose should carry.
export const PROSE_FORMAT =
	'Format it as manuscript prose: use *asterisks* only for italics, and no bold, headings, lists, or code.';

export const PLAIN_TEXT_FORMAT =
	'Write plain text with no Markdown: no asterisks, headings, lists, or code.';
