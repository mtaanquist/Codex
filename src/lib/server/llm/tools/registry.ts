import type { ToolSpec } from '../providers/types.ts';

// The tools the Assistant may call. Read tools fetch authoritative data and run
// immediately (they write nothing); write tools stage a human-approved change
// (a review suggestion or comment) and never touch authored content directly -
// the "writes are suggestions" invariant. The dispatcher (dispatch.ts) enforces
// that split; this is just the catalogue and its JSON-Schema argument shapes.

export type ToolKind = 'read' | 'write';

// A scoped tool acts on a target carried in the dispatch context (a review
// thread, a suggestion) rather than on ids the model supplies, and is only
// offered when a surface names it explicitly - never in the default set.
//
// An external tool is offered only to an outside app connected through the
// MCP endpoint (see #lib/server/mcp/tools). The in-app Assistant never gets
// one: it already knows the open universe and story from the page. These are
// the listed exceptions to "one toolbox for both"; keep the list short.
export type ToolDef = ToolSpec & { kind: ToolKind; scoped?: boolean; external?: boolean };

function obj(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
	return { type: 'object', properties, required, additionalProperties: false };
}

const str = (description: string) => ({ type: 'string', description });

export const TOOLS: ToolDef[] = [
	{
		kind: 'read',
		external: true,
		name: 'list_universes',
		description:
			"List the writer's universes with each one's id, name, description and number of stories. Every other tool needs a universe id from this list.",
		parameters: obj({}, [])
	},
	{
		kind: 'read',
		external: true,
		name: 'list_stories',
		description:
			"List the stories in this universe with each one's id, title, one-line brief and number of scenes. Use list_scenes for their chapters and scenes.",
		parameters: obj({}, [])
	},
	{
		kind: 'read',
		name: 'list_scenes',
		description:
			"List the chapters and scenes of every story in this universe, grouped by story, with each scene's id, title, status, and summary. Use the ids with get_scene to read a scene in full.",
		parameters: obj({}, [])
	},
	{
		kind: 'read',
		name: 'get_scene',
		description:
			"Fetch a scene's title, status, summary, and full prose body by its id. The scene can belong to any story in this universe, so you can read across stories to check continuity.",
		parameters: obj({ sceneId: str('The scene id.') }, ['sceneId'])
	},
	{
		kind: 'read',
		name: 'get_entity',
		description:
			'Fetch a character, place, or lore entry by its id: name, summary, description, quick details, aliases, and related entities.',
		parameters: obj({ entityId: str('The entity id.') }, ['entityId'])
	},
	{
		kind: 'read',
		name: 'find_appearances',
		description:
			'List where an entity is mentioned across the stories in this universe, with a text snippet, the owning story, and the character offset of each mention, for grounding and citation.',
		parameters: obj({ entityId: str('The entity id.') }, ['entityId'])
	},
	{
		kind: 'read',
		name: 'search_text',
		description:
			'Search the stories, scenes, entities, and prose in this universe by substring (prose is searched only for queries of three or more characters). Returns labelled results with links.',
		parameters: obj({ query: str('The text to search for.') }, ['query'])
	},
	{
		kind: 'read',
		name: 'list_review_notes',
		description:
			'List the review notes you have left on a story: the comments and pattern notes you opened, each with how many of its edits are pending, accepted or rejected, and your other suggested edits with their status. writerRepliedLast marks a note where the writer wrote last and may be waiting for your answer. Use get_review_note to read one.',
		parameters: obj({ storyId: str('The story id.') }, ['storyId'])
	},
	{
		kind: 'read',
		name: 'get_review_note',
		description:
			'Read one of your own review notes: the note, the replies between you and the writer in order, and for each of its edits the status, the original text, the text as applied if the writer accepted it, and the paragraph as it now stands. Use it to see what the writer decided and to answer what they wrote.',
		parameters: obj(
			{
				noteId: str(
					'The id of a note you opened, or of a suggested edit you made, from list_review_notes.'
				)
			},
			['noteId']
		)
	},
	{
		kind: 'write',
		name: 'suggest_edit',
		description:
			'Propose replacing an exact passage of a scene with new text. Staged as a suggestion the author accepts or rejects; it never changes the scene directly. The original passage must appear exactly once in the scene.',
		parameters: obj(
			{
				sceneId: str('The scene id.'),
				original: str('The exact existing text to replace (must occur once in the scene).'),
				replacement: str(
					'The proposed replacement text, as manuscript prose with *asterisks* only for italics and no other Markdown (empty string to delete the passage).'
				),
				reason: str(
					'Optional: one short sentence on why this change helps, so the author can learn the habit. Leave it out for an obvious fix such as a typo, a spelling slip or missing punctuation.'
				)
			},
			['sceneId', 'original', 'replacement']
		)
	},
	{
		kind: 'write',
		name: 'propose_scene_split',
		description:
			'Propose splitting a scene in two at a point you choose. The writer sees the proposal with your reasoning and confirms or ignores it; nothing changes until they confirm. Quote the words the NEW scene will open with: if the break falls between "...and slept." and "Dawn came swiftly.", pass "Dawn came swiftly.", never "...and slept."',
		parameters: obj(
			{
				sceneId: str('The scene id.'),
				newSceneStart: str(
					'The exact opening words of the new scene: the first text after the break, never the text the current scene ends with. Must occur exactly once in the scene.'
				),
				rationale: str('One or two sentences on why this is a natural break.')
			},
			['sceneId', 'newSceneStart', 'rationale']
		)
	},
	{
		kind: 'write',
		external: true,
		name: 'stage_scene_draft',
		description:
			'Hand the writer a draft you wrote for a scene. It waits on the scene in Codex, where the writer reads it and either keeps it (into the scene while it is empty, or as a new scene after it) or discards it; it never replaces prose the writer has. A scene takes one undecided draft at a time.',
		parameters: obj(
			{
				sceneId: str('The scene id.'),
				text: str(
					'The draft, as manuscript prose with *asterisks* only for italics and no other Markdown.'
				),
				brief: str('Optional: one or two sentences on what you were asked to write.')
			},
			['sceneId', 'text']
		)
	},
	{
		kind: 'write',
		name: 'suggest_entity',
		description:
			'Suggest a character, place or lore entry the universe has no entry for yet, such as someone the text names again and again. Staged for the writer to accept or dismiss; nothing is created until they accept. Refused for a name, or another name of an entry, the universe already has: look with search_text first.',
		parameters: obj(
			{
				kind: { type: 'string', enum: ['character', 'place', 'lore'], description: 'What it is.' },
				name: str('The name of the entry.'),
				description: str('Optional: one or two sentences on who or what it is.'),
				seenIn: str('Optional: where in the text it turns up, such as a scene title and a quote.')
			},
			['kind', 'name']
		)
	},
	{
		kind: 'write',
		name: 'leave_comment',
		description:
			'Leave a review comment on a scene, optionally anchored to a quoted passage. Staged for the author like a guest reviewer comment.',
		parameters: obj(
			{
				sceneId: str('The scene id.'),
				comment: str('The comment text.'),
				quote: str(
					'Optional exact passage to anchor the comment to; omit for a whole-scene comment.'
				)
			},
			['sceneId', 'comment']
		)
	},
	{
		kind: 'write',
		name: 'leave_pattern_note',
		description:
			'Leave a whole-scene note about a recurring pattern in the prose (an epithet habit, a pet phrase, filter verbs) together with the line edits that fix its instances. The note and every edit are staged in one call and linked, so the author can work through them in order. Edits whose passage is not found are reported back; to retry them, call this again with the same sceneId and comment and only those edits.',
		parameters: obj(
			{
				sceneId: str('The scene id.'),
				comment: str(
					'The note, opening with "Pattern note (<the pattern>):" and saying what the pattern is and why it matters.'
				),
				edits: {
					type: 'array',
					description: 'One entry per instance you would change, in scene order.',
					items: obj(
						{
							original: str('The exact existing text to replace (must occur once in the scene).'),
							replacement: str(
								'The proposed replacement text, as manuscript prose with *asterisks* only for italics.'
							),
							reason: str(
								'Optional: one short sentence on why this change helps, so the author can learn the habit. Leave it out for an obvious fix such as a typo, a spelling slip or missing punctuation.'
							)
						},
						['original', 'replacement']
					)
				},
				kept: {
					type: 'array',
					description:
						'Optional: instances you left alone on purpose, such as one that helps the rhythm, and why.',
					items: obj(
						{ quote: str('The instance you kept.'), reason: str('Why it stays, in a few words.') },
						['quote', 'reason']
					)
				}
			},
			['sceneId', 'comment', 'edits']
		)
	},
	{
		kind: 'write',
		scoped: true,
		name: 'reply_in_thread',
		description:
			'Reply in the review thread under discussion. The reply is posted under your name; the thread is fixed by the request, not chosen here.',
		parameters: obj({ comment: str('The reply text.') }, ['comment'])
	},
	{
		kind: 'write',
		scoped: true,
		name: 'update_suggestion',
		description:
			'Revise the replacement text of your own pending suggestion under discussion. The passage it replaces stays the same; only the proposed new text changes. The suggestion is fixed by the request, not chosen here.',
		parameters: obj({ replacement: str('The revised replacement text.') }, ['replacement'])
	}
];

// The reduced-capability set, for an endpoint running a smaller local model:
// one way to read a scene and the two ways to hand something back to the
// author. Everything else (the skeleton, entity lookups, search, splits) is
// dropped, so fewer schemas ride on each round.
export const MINIMAL_TOOL_NAMES = ['get_scene', 'suggest_edit', 'leave_comment'];

// The specs offered to the in-app model: the default set leaves the scoped
// tools out; a surface that needs them names them explicitly. The external
// tools are never offered here, even by name.
export function toolSpecs(names?: string[]): ToolSpec[] {
	const inApp = TOOLS.filter((tool) => !tool.external);
	const picked = names
		? inApp.filter((tool) => names.includes(tool.name))
		: inApp.filter((tool) => !tool.scoped);
	return picked.map(({ kind, scoped, external, ...spec }) => {
		void kind;
		void scoped;
		void external;
		return spec;
	});
}

export function findTool(name: string): ToolDef | undefined {
	return TOOLS.find((tool) => tool.name === name);
}
