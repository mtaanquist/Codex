// The kinds of work the Assistant picks a model for, as the settings pages name
// them. The ids match the roles the gateway resolves a model for; tip is advice
// that holds on any model.
export const ROLE_META = [
	{
		id: 'chat',
		name: 'Rubber duck',
		hint: 'Conversational side panel. Best with a smart, chatty model.',
		tip: ''
	},
	{
		id: 'coauthor',
		name: 'Co-author',
		hint: 'Generates passages you can insert or edit. Prefer strong prose quality.',
		tip: ''
	},
	{
		id: 'continuation',
		name: 'Continuation',
		hint: 'Inline ghost-text suggestions. Fast and light is what matters.',
		tip: 'Turn thinking off.'
	},
	{
		id: 'reviewer',
		name: 'Reviewer',
		hint: 'Reads a draft and leaves suggested edits in your name.',
		tip: 'Set a low temperature; thinking is optional.'
	},
	{
		id: 'utility',
		name: 'Background work',
		hint: 'Summaries, suggested entity details, and recaps. Runs while you work.',
		tip: 'Turn thinking off.'
	}
] as const;
