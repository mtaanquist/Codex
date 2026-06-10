import type { ToolSpec } from '../providers/types';

// The tools the Assistant may call. Read tools fetch authoritative data and run
// immediately (they write nothing); write tools stage a human-approved change
// (a review suggestion or comment) and never touch authored content directly -
// the "writes are suggestions" invariant. The dispatcher (dispatch.ts) enforces
// that split; this is just the catalogue and its JSON-Schema argument shapes.

export type ToolKind = 'read' | 'write';

export type ToolDef = ToolSpec & { kind: ToolKind };

function obj(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
	return { type: 'object', properties, required, additionalProperties: false };
}

const str = (description: string) => ({ type: 'string', description });

export const TOOLS: ToolDef[] = [
	{
		kind: 'read',
		name: 'list_scenes',
		description:
			"List the story's chapters and scenes in order, with each scene's id, title, status, and summary. Use the ids with get_scene to read a scene in full.",
		parameters: obj({}, [])
	},
	{
		kind: 'read',
		name: 'get_scene',
		description: "Fetch a scene's title, status, summary, and full prose body by its id.",
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
			'List where an entity is mentioned in the current story, with a text snippet and the character offset of each mention, for grounding and citation.',
		parameters: obj({ entityId: str('The entity id.') }, ['entityId'])
	},
	{
		kind: 'read',
		name: 'search_text',
		description:
			"Search the author's own universes, stories, scenes, entities, and prose by substring. Returns labelled results with links.",
		parameters: obj({ query: str('The text to search for.') }, ['query'])
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
				replacement: str('The proposed replacement text (empty string to delete the passage).')
			},
			['sceneId', 'original', 'replacement']
		)
	},
	{
		kind: 'write',
		name: 'propose_scene_split',
		description:
			'Propose splitting a scene in two at a point you choose. The writer sees the proposal with your reasoning and confirms or ignores it; nothing changes until they confirm. The split point is where the new scene begins.',
		parameters: obj(
			{
				sceneId: str('The scene id.'),
				before: str(
					'The exact text the new scene should start at (must occur exactly once in the scene).'
				),
				rationale: str('One or two sentences on why this is a natural break.')
			},
			['sceneId', 'before', 'rationale']
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
	}
];

export function toolSpecs(): ToolSpec[] {
	return TOOLS.map(({ kind, ...spec }) => {
		void kind;
		return spec;
	});
}

export function findTool(name: string): ToolDef | undefined {
	return TOOLS.find((tool) => tool.name === name);
}
