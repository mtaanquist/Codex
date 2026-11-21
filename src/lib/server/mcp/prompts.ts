import { findAsk, whoAsk } from '../../assistant-slash.ts';
import type { McpPermission } from '../../mcp-access.ts';
import { REVIEW_CATEGORIES, type ReviewCategory } from '../../review-shape.ts';
import {
	clampDraftWords,
	FALLBACK_DRAFT_WORDS,
	MAX_DRAFT_BRIEF_CHARS,
	MAX_DRAFT_POV_CHARS
} from '../../scene-draft.ts';
import { isUuid } from '../../slug.ts';
import { buildCoauthorMessage, MAX_COAUTHOR_REFERENCE_CHARS } from '../llm/prompts/coauthor.ts';
import { READ_WITH_TOOLS } from '../llm/prompts/format.ts';
import { buildRecapMessage } from '../llm/prompts/recap.ts';
import {
	buildContinuityBrief,
	buildPatternBrief,
	buildReviewMessage,
	CHAPTER_PATTERN_CAP
} from '../llm/prompts/review.ts';
import { buildSceneDraftMessage, CONTINUE_RULE } from '../llm/prompts/scene-draft.ts';

// The Assistant's flow commands as MCP prompts: one per command that starts a
// piece of work in the chat panel (/review, /copyedit, ...). A prompt is the
// instruction the Assistant itself is given for that work, from the same
// builders (llm/prompts), framed for an agent that has no assembled context
// and reads through the tools instead.
//
// A prompt reads nothing from the database. It is text built from the
// arguments the caller sent, so it can say nothing about anyone's work; the
// tools it points at check every id against the connected writer.

export type PromptArgument = { name: string; description: string; required: boolean };

type PromptDef = {
	name: string;
	title: string;
	description: string;
	// The permission the work needs; a prompt that stages notes is not offered
	// to a connection that may only read.
	needs: McpPermission;
	arguments: PromptArgument[];
	build: (args: Args, connection: PromptConnection) => string;
};

export type McpPrompt = Pick<PromptDef, 'name' | 'title' | 'description' | 'arguments'>;
export type PromptConnection = { permissions: readonly McpPermission[] };

// How a drafting prompt ends: staged where the connection may suggest, else
// in the reply.
function draftClose(connection: PromptConnection, each: boolean, thing = 'draft'): string {
	if (!connection.permissions.includes('suggest')) {
		return each
			? `Reply with the drafts in scene order, each under a line that names its scene. ${NOT_STORED}`
			: REPLY_ONLY;
	}
	return `You cannot change the writer's text. Do not put ${each ? 'the drafts' : `the ${thing}`} in your reply. Hand ${each ? 'each one' : 'it'} to the writer with stage_scene_draft on its scene${each ? ', as soon as it is written' : ''}: it waits there for the writer to read, and they keep or discard it in Codex. It never replaces prose the writer has. Then tell the writer ${each ? 'which scenes have a draft waiting' : `that the ${thing} is waiting on the scene`}.`;
}

// A prompt's arguments arrive as text. Every read goes through these, so a
// bad one is refused with a message that names it.
export class PromptArgumentError extends Error {}

type Args = Record<string, unknown>;

// The longest free-text argument that is not a brief (a name, a query, a
// chapter title).
const MAX_SHORT_TEXT = 200;

function text(args: Args, name: string, max: number, required = true): string {
	const value = args[name];
	const trimmed = typeof value === 'string' ? value.trim() : '';
	if (!trimmed) {
		if (required) throw new PromptArgumentError(`Give "${name}".`);
		return '';
	}
	if (trimmed.length > max) {
		throw new PromptArgumentError(`"${name}" is too long; keep it under ${max} characters.`);
	}
	return trimmed;
}

function id(args: Args, name: string, from: string, required = true): string {
	const value = text(args, name, MAX_SHORT_TEXT, required);
	if (value && !isUuid(value)) {
		throw new PromptArgumentError(`"${name}" must be an id from ${from}.`);
	}
	return value;
}

const UNIVERSE: PromptArgument = {
	name: 'universeId',
	description: 'The id of the universe to work in, from list_universes.',
	required: true
};
const SCENE: PromptArgument = {
	name: 'sceneId',
	description: 'The id of the scene, from list_scenes.',
	required: true
};
const STORY: PromptArgument = {
	name: 'storyId',
	description: 'The id of the story, from list_stories.',
	required: true
};

const universe = (args: Args) => id(args, 'universeId', 'list_universes');
const scene = (args: Args) => id(args, 'sceneId', 'list_scenes');
const story = (args: Args, required = true) => id(args, 'storyId', 'list_stories', required);

// ---- the frame around every prompt ----

const reading = (universeId: string) =>
	[
		`You are working in a writer's Codex through its tools. The universe id is ${universeId}; pass it as universeId on every call.`,
		"The instructions below were written for an assistant that is handed the story as context. You have no such context: read what you need with the tools. list_stories and list_scenes give the outline with each scene's summary, get_scene gives a scene's text, and search_text, get_entity and find_appearances give the characters, places and lore."
	].join('\n');

const STAGES_ONLY =
	"You cannot change the writer's text. suggest_edit, leave_comment and leave_pattern_note only stage notes that wait in the writer's review in Codex, where the writer accepts or rejects each one. When you are done, tell the writer what you left and that it is waiting in Review.";

const NOT_STORED =
	'Nothing you write here is put into Codex; the writer copies in what they want to keep.';
const REPLY_ONLY = `Give the result in your reply. ${NOT_STORED}`;

function framed(universeId: string, body: string[], close: string): string {
	return [reading(universeId), '', ...body, '', close].join('\n');
}

const currentScene = (sceneId: string) =>
	`"The current scene" below is the scene with id ${sceneId}. Read it with get_scene first, and the scenes before it in list_scenes for the voice, tense and point of view.`;

function categories(args: Args): ReviewCategory[] {
	const asked = text(args, 'focus', MAX_SHORT_TEXT, false)
		.split(/[\s,]+/)
		.filter(Boolean)
		.map((word) => word.toLowerCase());
	const unknown = asked.find((word) => !(REVIEW_CATEGORIES as readonly string[]).includes(word));
	if (unknown) {
		throw new PromptArgumentError(
			`"focus" takes any of ${REVIEW_CATEGORIES.join(', ')}, separated by commas.`
		);
	}
	return REVIEW_CATEGORIES.filter((category) => asked.includes(category));
}

function words(args: Args): number {
	const asked = text(args, 'words', MAX_SHORT_TEXT, false);
	if (!asked) return FALLBACK_DRAFT_WORDS;
	if (!/^\d+$/.test(asked)) throw new PromptArgumentError('"words" must be a whole number.');
	return clampDraftWords(Number(asked));
}

const review = (args: Args, picked: ReviewCategory[]) =>
	framed(
		universe(args),
		// With leave_pattern_note on offer, and the scene's text still to be read.
		[
			buildReviewMessage({ id: scene(args), title: null }, [], picked, false, true, READ_WITH_TOOLS)
		],
		STAGES_ONLY
	);

const PROMPTS: PromptDef[] = [
	{
		name: 'review',
		title: 'Review a scene',
		description:
			'Review one scene and leave a few high-value comments and suggested edits for the writer to decide on. For a chapter or a story, run it for each scene in order.',
		needs: 'suggest',
		arguments: [
			UNIVERSE,
			SCENE,
			{
				name: 'focus',
				description:
					'Optional. Leave out for a few high-value notes. For an exhaustive pass name any of: mechanics (spelling and grammar), prose (prose and style), lore (entities, continuity and lore), separated by commas.',
				required: false
			}
		],
		build: (args) => review(args, categories(args))
	},
	{
		name: 'copyedit',
		title: 'Copyedit a scene',
		description:
			'A full copyedit of one scene: every spelling, grammar, prose and continuity issue, staged for the writer to decide on. For a chapter or a story, run it for each scene in order.',
		needs: 'suggest',
		arguments: [UNIVERSE, SCENE],
		build: (args) => review(args, [...REVIEW_CATEGORIES])
	},
	{
		name: 'continuity-review',
		title: 'Continuity review',
		description:
			'Check a story, or every story in the universe against the others, for contradictions between scenes, and leave a note on each one the text bears out.',
		needs: 'suggest',
		arguments: [
			UNIVERSE,
			{
				name: 'storyId',
				description:
					'Optional. The id of one story to check, from list_stories. Leave out to check every story in the universe against the others.',
				required: false
			}
		],
		build: (args) => {
			const storyId = story(args, false);
			return framed(
				universe(args),
				[buildContinuityBrief(storyId ? { scope: 'story', storyId } : { scope: 'universe' })],
				STAGES_ONLY
			);
		}
	},
	{
		name: 'pattern-pass',
		title: 'Pattern pass',
		description:
			'Find the habits that repeat in the prose of a chapter or a story (an epithet, a pet phrase, filter verbs) and leave one note for each with a suggested fix for every instance, which the writer works through in Codex.',
		needs: 'suggest',
		arguments: [
			UNIVERSE,
			STORY,
			{
				name: 'chapter',
				description:
					'Optional. The title of one chapter, as list_scenes shows it. Leave out to go through the story chapter by chapter.',
				required: false
			}
		],
		build: (args) =>
			framed(
				universe(args),
				[
					buildPatternBrief({
						storyId: story(args),
						chapter: text(args, 'chapter', MAX_SHORT_TEXT, false),
						cap: CHAPTER_PATTERN_CAP
					})
				],
				`${STAGES_ONLY} Give the writer the link each pattern note returned; it opens the note in Codex and takes them through its edits one at a time.`
			)
	},
	{
		name: 'write',
		title: 'Write a passage',
		description: 'Write a passage for a scene from a brief, in the voice of the story.',
		needs: 'read',
		arguments: [
			UNIVERSE,
			SCENE,
			{ name: 'brief', description: 'What the passage should do.', required: true }
		],
		build: (args, connection) =>
			framed(
				universe(args),
				[
					currentScene(scene(args)),
					buildCoauthorMessage(text(args, 'brief', MAX_DRAFT_BRIEF_CHARS), null, {
						source: READ_WITH_TOOLS
					})
				],
				draftClose(connection, false, 'passage')
			)
	},
	{
		name: 'rewrite',
		title: 'Rewrite a passage',
		description:
			'Rewrite a passage of a scene to an instruction. With permission to suggest, the rewrite is also staged as a suggested edit for the writer to accept.',
		needs: 'read',
		arguments: [
			UNIVERSE,
			SCENE,
			{
				name: 'passage',
				description: 'The passage to rewrite, exactly as it stands in the scene.',
				required: true
			},
			{ name: 'instruction', description: 'How to rewrite it.', required: true }
		],
		build: (args, connection) => {
			const sceneId = scene(args);
			return framed(
				universe(args),
				[
					currentScene(sceneId),
					buildCoauthorMessage(
						text(args, 'instruction', MAX_DRAFT_BRIEF_CHARS),
						{ kind: 'selection', text: text(args, 'passage', MAX_COAUTHOR_REFERENCE_CHARS) },
						{ source: READ_WITH_TOOLS, rewrite: true }
					)
				],
				connection.permissions.includes('suggest')
					? `Then stage it with suggest_edit on the scene with id ${sceneId}: the passage exactly as it stands in the scene as "original", your version as "replacement". ${STAGES_ONLY}`
					: REPLY_ONLY
			);
		}
	},
	{
		name: 'draft',
		title: 'Draft a scene',
		description: 'Draft a whole scene from a brief, carrying on from any prose it already has.',
		needs: 'read',
		arguments: [
			UNIVERSE,
			SCENE,
			{ name: 'brief', description: 'What happens in the scene.', required: true },
			{
				name: 'words',
				description: `Optional. About how many words to write; ${FALLBACK_DRAFT_WORDS} when left out.`,
				required: false
			},
			{
				name: 'pov',
				description: 'Optional. Whose point of view to write from.',
				required: false
			}
		],
		build: (args, connection) =>
			framed(
				universe(args),
				[
					currentScene(scene(args)),
					`If the scene already has prose: ${CONTINUE_RULE}`,
					buildSceneDraftMessage({
						source: READ_WITH_TOOLS,
						brief: text(args, 'brief', MAX_DRAFT_BRIEF_CHARS),
						targetWords: words(args),
						pov: text(args, 'pov', MAX_DRAFT_POV_CHARS, false)
					})
				],
				draftClose(connection, false)
			)
	},
	{
		name: 'draft-chapter',
		title: 'Draft a chapter',
		description: 'Draft the scenes of a chapter one by one from a brief for the chapter.',
		needs: 'read',
		arguments: [
			UNIVERSE,
			STORY,
			{
				name: 'chapter',
				description: 'The title of the chapter, as list_scenes shows it.',
				required: true
			},
			{ name: 'brief', description: 'What happens in the chapter.', required: true },
			{
				name: 'words',
				description: `Optional. About how many words to write for each scene; ${FALLBACK_DRAFT_WORDS} when left out.`,
				required: false
			}
		],
		build: (args, connection) =>
			framed(
				universe(args),
				[
					`Draft the scenes of the chapter "${text(args, 'chapter', MAX_SHORT_TEXT)}" of the story with id ${story(args)}, one at a time, in the order list_scenes gives them. Read the chapters before it for the voice, tense and point of view.`,
					`Each scene in turn is "the current scene" below. Read it with get_scene first; if it already has prose: ${CONTINUE_RULE} From the second scene on, carry on from where your draft of the one before ends and do not repeat it. A scene's summary in list_scenes is the writer's plan for it.`,
					buildSceneDraftMessage({
						source: READ_WITH_TOOLS,
						brief: '',
						chapterBrief: text(args, 'brief', MAX_DRAFT_BRIEF_CHARS),
						targetWords: words(args)
					})
				],
				draftClose(connection, true)
			)
	},
	{
		name: 'catchup',
		title: 'Catch me up',
		description:
			'Recap a story so far: the key events in order, where the characters stand, and the open threads.',
		needs: 'read',
		arguments: [
			UNIVERSE,
			STORY,
			{
				name: 'throughScene',
				description:
					'Optional. The title of the scene to stop at, as list_scenes shows it. Leave out for the whole story.',
				required: false
			}
		],
		build: (args) =>
			framed(
				universe(args),
				[
					`The story is the one with id ${story(args)}. "The material provided" below is what list_scenes gives for it: each scene's summary, in order. Read a scene with get_scene where its summary is missing.`,
					buildRecapMessage(text(args, 'throughScene', MAX_SHORT_TEXT, false) || null)
				],
				REPLY_ONLY
			)
	},
	{
		name: 'who',
		title: 'Character or place sheet',
		description: 'Show the key facts Codex holds on a character, a place or a lore entry.',
		needs: 'read',
		arguments: [UNIVERSE, { name: 'name', description: 'The name to look up.', required: true }],
		build: (args) =>
			framed(
				universe(args),
				[
					whoAsk(text(args, 'name', MAX_SHORT_TEXT)),
					'Find the entry with search_text and read it with get_entity. find_appearances shows where it turns up in the text.'
				],
				REPLY_ONLY
			)
	},
	{
		name: 'find',
		title: 'Search this universe',
		description: 'Search the stories, scenes, entries and prose of a universe.',
		needs: 'read',
		arguments: [
			UNIVERSE,
			{ name: 'query', description: 'The text to search for.', required: true }
		],
		build: (args) =>
			framed(
				universe(args),
				[findAsk(text(args, 'query', MAX_SHORT_TEXT)), 'Use search_text.'],
				REPLY_ONLY
			)
	}
];

// The prompts a connection is offered.
export function mcpPrompts(permissions: readonly McpPermission[]): McpPrompt[] {
	return PROMPTS.filter((prompt) => permissions.includes(prompt.needs)).map(
		({ name, title, description, arguments: args }) => ({
			name,
			title,
			description,
			arguments: args
		})
	);
}

// The text of one prompt for these arguments. Throws PromptArgumentError for a
// prompt the connection is not offered and for an argument it cannot use.
export function buildMcpPrompt(name: string, args: Args, connection: PromptConnection): string {
	const prompt = PROMPTS.find((entry) => entry.name === name);
	if (!prompt || !connection.permissions.includes(prompt.needs)) {
		throw new PromptArgumentError(`Unknown prompt: ${name}.`);
	}
	return prompt.build(args, connection);
}
