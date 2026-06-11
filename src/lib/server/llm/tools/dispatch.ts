import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../../auth';
import { scenes, stories } from '../../db/schema';
import { entityAppearances, getEntityCard } from '../../plan-data';
import { searchAll } from '../../search';
import {
	addComment,
	createSuggestion,
	createThread,
	updateAssistantSuggestion
} from '../../review';
import { locateSplitBefore } from '$lib/scene-split-locate';
import { storySkeleton, type SceneSummary } from '../context/sources';
import type { ProviderToolCall, SplitProposal } from '../providers/types';
import { findTool } from './registry';

// Executes one tool call within an owner-scoped story context. Read tools query
// and return data; write tools stage a review suggestion or comment and report
// "staged" without touching authored content. Every handler is scoped to the
// context's story and user, so a tool cannot reach another author's work even
// if the model invents an id.

export type ToolContext = {
	db: Database;
	userId: string;
	storyId: string;
	// Targets for the scoped tools (reply_in_thread, update_suggestion), fixed
	// by the calling surface so the model cannot reach another thread or
	// suggestion even by inventing ids.
	scope?: { threadId?: string; suggestionId?: string };
	// The tools actually offered this turn. A call to anything else is refused:
	// the prompt-level restriction ("do not leave new comments elsewhere") must
	// hold even when the model ignores it or answers a cached tool schema.
	allowedTools?: string[];
};

export type ToolOutcome = {
	// The text fed back to the model as the tool result.
	result: string;
	// True when the call staged a human-approved change.
	staged: boolean;
	// A staged action the surface should show alongside the reply (a proposal
	// card with a confirm button); the gateway forwards it on the stream.
	surface?: { type: 'proposal'; proposal: SplitProposal };
};

const MAX_SCENE_BODY = 12000;
const MAX_APPEARANCES = 20;

// Whether the story belongs to the user; the gateway gates tool use on this so
// the context is trusted.
export async function ownsStory(db: Database, userId: string, storyId: string): Promise<boolean> {
	const [row] = await db
		.select({ id: stories.id })
		.from(stories)
		.where(and(eq(stories.id, storyId), eq(stories.ownerId, userId)));
	return Boolean(row);
}

export async function dispatchToolCall(
	ctx: ToolContext,
	call: ProviderToolCall
): Promise<ToolOutcome> {
	const tool = findTool(call.name);
	if (!tool) return { result: `Unknown tool: ${call.name}.`, staged: false };
	if (ctx.allowedTools && !ctx.allowedTools.includes(call.name)) {
		return {
			result: `The tool ${call.name} is not available in this turn. Use one of the offered tools.`,
			staged: false
		};
	}
	let args: Record<string, unknown>;
	try {
		args = call.arguments ? JSON.parse(call.arguments) : {};
	} catch {
		return { result: 'Could not parse the tool arguments as JSON.', staged: false };
	}
	try {
		switch (call.name) {
			case 'list_scenes':
				return { result: await listScenes(ctx), staged: false };
			case 'get_scene':
				return { result: await getScene(ctx, asString(args.sceneId)), staged: false };
			case 'get_entity':
				return { result: await getEntity(ctx, asString(args.entityId)), staged: false };
			case 'find_appearances':
				return { result: await findAppearances(ctx, asString(args.entityId)), staged: false };
			case 'search_text':
				return { result: await searchText(ctx, asString(args.query)), staged: false };
			case 'suggest_edit':
				return suggestEdit(ctx, {
					sceneId: asString(args.sceneId),
					original: asString(args.original),
					replacement: asString(args.replacement)
				});
			case 'leave_comment':
				return leaveComment(ctx, {
					sceneId: asString(args.sceneId),
					comment: asString(args.comment),
					quote: typeof args.quote === 'string' ? args.quote : undefined
				});
			case 'propose_scene_split':
				return proposeSceneSplit(ctx, {
					sceneId: asString(args.sceneId),
					// The old parameter name rides as a fallback for any provider
					// still answering against a cached tool schema. Remove once
					// cached schemas have aged out; nothing else uses "before".
					before: asString(args.newSceneStart) || asString(args.before),
					rationale: asString(args.rationale)
				});
			case 'reply_in_thread':
				return replyInThread(ctx, asString(args.comment));
			case 'update_suggestion':
				return updateSuggestion(ctx, asString(args.replacement));
			default:
				return { result: `Unhandled tool: ${call.name}.`, staged: false };
		}
	} catch (err) {
		return {
			result: `Tool error: ${err instanceof Error ? err.message : 'failed'}.`,
			staged: false
		};
	}
}

function asString(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

// An owner-scoped, in-story scene fetch shared by the read and write handlers.
async function loadScene(ctx: ToolContext, sceneId: string) {
	const [row] = await ctx.db
		.select({
			id: scenes.id,
			title: scenes.title,
			status: scenes.status,
			summaryMd: scenes.summaryMd,
			bodyMd: scenes.bodyMd
		})
		.from(scenes)
		.innerJoin(stories, eq(scenes.storyId, stories.id))
		.where(
			and(
				eq(scenes.id, sceneId),
				eq(scenes.storyId, ctx.storyId),
				eq(stories.ownerId, ctx.userId),
				isNull(scenes.deletedAt)
			)
		);
	return row ?? null;
}

// The chapter and scene skeleton, so the model can find a scene's id and read
// it with get_scene. ctx.storyId is owner-verified by the gateway before any
// tool runs, so the skeleton query needs no further scoping.
async function listScenes(ctx: ToolContext): Promise<string> {
	const skeleton = await storySkeleton(ctx.db, ctx.storyId);
	const scene = (s: SceneSummary) => ({
		id: s.id,
		title: s.title,
		status: s.status,
		summary: s.summaryMd
	});
	return JSON.stringify({
		chapters: skeleton.chapters.map((c) => ({
			title: c.title,
			summary: c.summaryMd,
			scenes: c.scenes.map(scene)
		})),
		unfiledScenes: skeleton.orphans.map(scene)
	});
}

async function getScene(ctx: ToolContext, sceneId: string): Promise<string> {
	const scene = await loadScene(ctx, sceneId);
	if (!scene) return 'No scene with that id in this story.';
	const body =
		scene.bodyMd.length > MAX_SCENE_BODY
			? `${scene.bodyMd.slice(0, MAX_SCENE_BODY)}\n...(truncated)`
			: scene.bodyMd;
	return JSON.stringify({
		id: scene.id,
		title: scene.title,
		status: scene.status,
		summary: scene.summaryMd,
		body
	});
}

async function getEntity(ctx: ToolContext, entityId: string): Promise<string> {
	const card = await getEntityCard(ctx.db, ctx.userId, entityId);
	if (!card) return 'No entity with that id.';
	return JSON.stringify({
		id: card.id,
		kind: card.kind,
		name: card.name,
		summary: card.summaryMd,
		description: card.bodyMd,
		aliases: card.aliases,
		details: card.details,
		related: card.related.map((r) => ({ id: r.id, name: r.name, kind: r.kind, label: r.label }))
	});
}

async function findAppearances(ctx: ToolContext, entityId: string): Promise<string> {
	const card = await getEntityCard(ctx.db, ctx.userId, entityId);
	if (!card) return 'No entity with that id.';
	const appearances = await entityAppearances(
		ctx.db,
		{ kind: card.kind, id: entityId },
		{ storyId: ctx.storyId }
	);
	return JSON.stringify(
		appearances.slice(0, MAX_APPEARANCES).map((a) => ({
			sceneId: a.sceneId,
			sceneTitle: a.sceneTitle,
			position: a.position,
			snippet: a.snippet
		}))
	);
}

async function searchText(ctx: ToolContext, query: string): Promise<string> {
	if (!query.trim()) return 'Provide a search query.';
	const results = await searchAll(ctx.db, ctx.userId, query);
	return JSON.stringify(
		results.map((r) => ({ type: r.type, label: r.label, detail: r.sublabel, href: r.href }))
	);
}

async function suggestEdit(
	ctx: ToolContext,
	input: { sceneId: string; original: string; replacement: string }
): Promise<ToolOutcome> {
	if (!input.original) return { result: 'Provide the exact text to replace.', staged: false };
	const scene = await loadScene(ctx, input.sceneId);
	if (!scene) return { result: 'No scene with that id in this story.', staged: false };
	const first = scene.bodyMd.indexOf(input.original);
	if (first === -1) {
		return { result: 'That exact passage was not found in the scene.', staged: false };
	}
	if (scene.bodyMd.indexOf(input.original, first + 1) !== -1) {
		return {
			result:
				'That passage appears more than once; include more surrounding text to make it unique.',
			staged: false
		};
	}
	const result = await createSuggestion(ctx.db, {
		storyId: ctx.storyId,
		sceneId: input.sceneId,
		author: { assistant: true },
		range: { start: first, end: first + input.original.length },
		replacement: input.replacement
	});
	if (!result.ok) return { result: result.reason, staged: false };
	return {
		result: `Staged a suggested edit (id ${result.suggestionId}). The author will accept or reject it; nothing has changed yet.`,
		staged: true
	};
}

// Stages nothing in the database: the proposal lives in the transcript as a
// card with a confirm button, and the confirm re-locates the text against the
// scene as it stands then. A bad split point goes back to the model as a
// retryable tool result.
async function proposeSceneSplit(
	ctx: ToolContext,
	input: { sceneId: string; before: string; rationale: string }
): Promise<ToolOutcome> {
	const scene = await loadScene(ctx, input.sceneId);
	if (!scene) return { result: 'No scene with that id in this story.', staged: false };
	const location = locateSplitBefore(scene.bodyMd, input.before);
	if (!location.ok) return { result: location.reason, staged: false };
	return {
		result:
			'The split proposal is shown to the writer with a confirm button. Nothing has changed yet; do not call this again for the same point.',
		staged: true,
		surface: {
			type: 'proposal',
			proposal: {
				sceneId: scene.id,
				sceneTitle: scene.title,
				before: input.before,
				rationale: input.rationale.trim()
			}
		}
	};
}

// The scoped reply: posts into the thread fixed by the calling surface, as
// the Assistant. No thread id crosses the model boundary.
async function replyInThread(ctx: ToolContext, comment: string): Promise<ToolOutcome> {
	const threadId = ctx.scope?.threadId;
	if (!threadId) return { result: 'There is no thread under discussion.', staged: false };
	if (!comment.trim()) return { result: 'Provide the reply text.', staged: false };
	const result = await addComment(ctx.db, {
		storyId: ctx.storyId,
		threadId,
		author: { assistant: true },
		body: comment
	});
	if (!result.ok) return { result: result.reason, staged: false };
	return { result: 'Your reply was posted to the thread.', staged: true };
}

// The scoped revision: amends the Assistant's own pending suggestion fixed by
// the calling surface. updateAssistantSuggestion enforces authorship and the
// pending status.
async function updateSuggestion(ctx: ToolContext, replacement: string): Promise<ToolOutcome> {
	const suggestionId = ctx.scope?.suggestionId;
	if (!suggestionId) {
		return { result: 'There is no suggestion under discussion.', staged: false };
	}
	const result = await updateAssistantSuggestion(ctx.db, {
		storyId: ctx.storyId,
		suggestionId,
		replacement
	});
	if (!result.ok) return { result: result.reason, staged: false };
	return {
		result: 'Your suggestion now proposes the revised text; the author still decides on it.',
		staged: true
	};
}

async function leaveComment(
	ctx: ToolContext,
	input: { sceneId: string; comment: string; quote?: string }
): Promise<ToolOutcome> {
	if (!input.comment.trim()) return { result: 'Provide the comment text.', staged: false };
	const scene = await loadScene(ctx, input.sceneId);
	if (!scene) return { result: 'No scene with that id in this story.', staged: false };
	let anchor: { start: number; end: number } | null = null;
	if (input.quote) {
		const at = scene.bodyMd.indexOf(input.quote);
		if (at !== -1) anchor = { start: at, end: at + input.quote.length };
	}
	const result = await createThread(ctx.db, {
		storyId: ctx.storyId,
		sceneId: input.sceneId,
		anchor,
		author: { assistant: true },
		body: input.comment
	});
	if (!result.ok) return { result: result.reason, staged: false };
	return { result: 'Staged a review comment for the author.', staged: true };
}
