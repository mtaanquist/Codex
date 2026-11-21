import { and, asc, count, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Database } from '../../auth.ts';
import {
	reviewComments,
	reviewSuggestions,
	reviewThreads,
	scenes,
	stories,
	universes
} from '../../db/schema.ts';
import { resolveOwnedEntity } from '../../entity-lookups.ts';
import { ownedUniverseRow, storyAssistantOn, storyIsLive } from '../../universe-scope.ts';
import { entityAppearances, getEntityCard } from '../../plan-data.ts';
import { searchAll } from '../../search.ts';
import {
	addComment,
	clientNotesWaiting,
	createSuggestion,
	createThread,
	MAX_COMMENT_LENGTH,
	openAssistantNote,
	updateAssistantSuggestion,
	type ClientAuthor,
	type MachineAuthor
} from '../../review.ts';
import { toLf } from '#lib/line-endings';
import { isUuid } from '#lib/slug';
import { locateSplitBefore } from '#lib/scene-split-locate';
import { locateQuote } from '#lib/quote-locate';
import { universeSkeleton, type SceneSummary } from '../context/sources.ts';
import type { ProviderToolCall, SplitProposal } from '../providers/types.ts';
import { findTool } from './registry.ts';

// Executes one tool call within an owner-scoped universe context. Read tools
// query and return data across every story in the universe; write tools stage a
// review suggestion or comment on a specific scene and report "staged" without
// touching authored content. Every handler is scoped to the context's universe
// and user, so a tool cannot reach another author's work even if the model
// invents an id. The reads reach the whole universe (the cross-story continuity
// payoff); the writes resolve the loaded scene's own owning story, never a
// fixed ctx.storyId, which is undefined on the universe surface.

export type ToolScope = {
	// Targets for the scoped tools (reply_in_thread, update_suggestion), fixed
	// by the calling surface so the model cannot reach another thread or
	// suggestion even by inventing ids.
	threadId?: string;
	suggestionId?: string;
	// Confine the scene reads (list_scenes, get_scene) to the focus story. Set
	// where the reply is posted somewhere a guest reviewer can read it, so an
	// injected instruction cannot pull in stories the guest was never shown.
	storyOnly?: boolean;
	// Link every suggest_edit this turn stages to this pattern note (the
	// chapter pattern pass and the re-read after an accept).
	patternThreadId?: string;
	// Mark every suggest_edit this turn stages as a follow-up to this accepted
	// edit (the re-read after an accept).
	followsSuggestionId?: string;
	// Refuse a suggest_edit outside this stretch of this scene (the re-read
	// after an accept looks at one paragraph and its neighbours).
	editWindow?: { sceneId: string; start: number; end: number };
	// The most suggest_edit calls that may stage in this turn (the re-read stages
	// at most one follow-up).
	maxEdits?: number;
};

// Edits staged so far per turn, for ToolScope.maxEdits. The gateway builds one
// context per turn and reuses it across the rounds of the tool loop.
const stagedEdits = new WeakMap<ToolContext, number>();

export type ToolContext = {
	db: Database;
	userId: string;
	// The retrieval reach: every story the user owns in this universe.
	universeId: string;
	// The focus story, when a single one is open (Write/Review/story-Plan). The
	// universe surface has none; write tools use the loaded scene's story, not
	// this.
	storyId?: string;
	scope?: ToolScope;
	// The tools actually offered this turn. A call to anything else is refused:
	// the prompt-level restriction ("do not leave new comments elsewhere") must
	// hold even when the model ignores it or answers a cached tool schema.
	allowedTools?: string[];
	// The turn's model context window in tokens, when known; it bounds how much
	// of a scene get_scene may return (see sceneBodyCap).
	contextWindow?: number;
	// Set when the call comes from an outside app through the MCP endpoint,
	// which is the only surface the external tools run on.
	external?: {
		// The most characters of a scene's text get_scene may return, where no
		// model window is known and the client caps the size of a result.
		sceneBodyCap: number;
		// The app, which is the author of anything the call stages.
		client: ClientAuthor;
		// The most notes the app may have waiting on one scene.
		maxNotesPerScene: number;
	};
};

// Who a staged note is from: the app on the MCP surface, the Assistant
// everywhere else.
function stagingAuthor(ctx: ToolContext): MachineAuthor {
	return ctx.external ? { client: ctx.external.client } : { assistant: true };
}

// The refusal for an app that already has its fill of notes waiting on a
// scene, or null when it may stage another. The Assistant has no such ceiling:
// its runs are bounded by the writer's own tool budget.
async function overCeiling(ctx: ToolContext, sceneId: string): Promise<string | null> {
	if (!ctx.external) return null;
	const waiting = await clientNotesWaiting(ctx.db, sceneId, ctx.external.client.id);
	if (waiting < ctx.external.maxNotesPerScene) return null;
	return `This scene already has ${waiting} of your notes waiting for the writer. Stage nothing more on it until they have decided on some.`;
}

export type ToolOutcome = {
	// The text fed back to the model as the tool result.
	result: string;
	// True when the call staged a human-approved change.
	staged: boolean;
	// True when what it staged is a review note on a scene (a suggested edit or
	// a comment). The review runs tally these from the agent loop rather than
	// counting rows before and after.
	note?: boolean;
	// How many notes the call staged, when one call stages several (a pattern
	// note with its edits); counts in place of note.
	noteCount?: number;
	// True when the handler threw. The result then carries the error's own
	// message, which is fine for the writer's model and not for an outside app.
	failed?: boolean;
	// A staged action the surface should show alongside the reply (a proposal
	// card with a confirm button); the gateway forwards it on the stream.
	surface?: { type: 'proposal'; proposal: SplitProposal };
};

// Bounds a get_scene result. Generous on purpose: a long novel scene runs
// 8-15K words (50-90K characters), and a review of a clipped scene is a
// review of the wrong text. The cap only guards against pathological bodies
// (a pasted data dump); prompt caching keeps the cost of big results down.
const MAX_SCENE_BODY = 200_000;
// With a known context window, one scene may take about a quarter of it, so the
// world context, the conversation, and the answer still fit. Tokens convert to
// characters at the usual rough four-to-one. The floor keeps a small window from
// clipping a scene to uselessness.
const CHARS_PER_TOKEN = 4;
const SCENE_BODY_WINDOW_SHARE = 0.25;
const MIN_SCENE_BODY = 8_000;
const MAX_APPEARANCES = 20;

function sceneBodyCap(ctx: ToolContext): number {
	if (ctx.external) return Math.min(MAX_SCENE_BODY, ctx.external.sceneBodyCap);
	const { contextWindow } = ctx;
	if (!contextWindow) return MAX_SCENE_BODY;
	const share = Math.floor(contextWindow * SCENE_BODY_WINDOW_SHARE * CHARS_PER_TOKEN);
	return Math.min(MAX_SCENE_BODY, Math.max(MIN_SCENE_BODY, share));
}

// The universe a story belongs to, but only if the user owns the story. The
// gateway derives the tool reach from the focus story when no universe is
// passed explicitly (the Write/Review/story-Plan surfaces); null means the
// story is not the user's.
export async function ownedStoryUniverse(
	db: Database,
	userId: string,
	storyId: string
): Promise<string | null> {
	const [row] = await db
		.select({ universeId: stories.universeId })
		.from(stories)
		.where(and(eq(stories.id, storyId), eq(stories.ownerId, userId), storyIsLive()));
	return row?.universeId ?? null;
}

// Whether the universe belongs to the user; the gateway gates universe-scoped
// tool use on this so the retrieval reach is trusted.
export async function ownsUniverse(
	db: Database,
	userId: string,
	universeId: string
): Promise<boolean> {
	return Boolean(await ownedUniverseRow(db, userId, universeId));
}

export async function dispatchToolCall(
	ctx: ToolContext,
	call: ProviderToolCall
): Promise<ToolOutcome> {
	const tool = findTool(call.name);
	if (!tool || (tool.external && !ctx.external)) {
		return { result: `Unknown tool: ${call.name}.`, staged: false };
	}
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
			case 'list_universes':
				return { result: await listUniverses(ctx), staged: false };
			case 'list_stories':
				return { result: await listStories(ctx), staged: false };
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
					replacement: asString(args.replacement),
					reason: asString(args.reason)
				});
			case 'leave_comment':
				return leaveComment(ctx, {
					sceneId: asString(args.sceneId),
					comment: asString(args.comment),
					quote: typeof args.quote === 'string' ? args.quote : undefined
				});
			case 'leave_pattern_note':
				return leavePatternNote(ctx, {
					sceneId: asString(args.sceneId),
					comment: asString(args.comment),
					edits: asList(args.edits).map((edit) => ({
						original: asString(edit.original),
						replacement: asString(edit.replacement),
						reason: asString(edit.reason)
					})),
					kept: asList(args.kept).map((entry) => ({
						quote: asString(entry.quote),
						reason: asString(entry.reason)
					}))
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
				return replyInThread(ctx, asString(args.comment), asString(args.threadId));
			case 'update_suggestion':
				return updateSuggestion(ctx, asString(args.replacement), asString(args.suggestionId));
			default:
				return { result: `Unhandled tool: ${call.name}.`, staged: false };
		}
	} catch (err) {
		return {
			result: `Tool error: ${err instanceof Error ? err.message : 'failed'}.`,
			staged: false,
			failed: true
		};
	}
}

function asString(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function asList(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object'
	);
}

// An owner-scoped scene fetch shared by the read and write handlers. Scoped to
// the universe (any owned scene in it, not just the focus story), and it
// selects the scene's own owning storyId so the write tools attribute a staged
// change to the right story even when the pass was launched from another.
async function loadScene(ctx: ToolContext, sceneId: string) {
	if (ctx.scope?.storyOnly && !ctx.storyId) return null;
	// An id that is not one at all is a miss like any other, not a query error.
	if (!isUuid(sceneId)) return null;
	const [row] = await ctx.db
		.select({
			id: scenes.id,
			storyId: scenes.storyId,
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
				eq(stories.universeId, ctx.universeId),
				eq(stories.ownerId, ctx.userId),
				isNull(stories.deletedAt),
				isNull(scenes.deletedAt),
				storyAssistantOn(),
				ctx.scope?.storyOnly && ctx.storyId ? eq(scenes.storyId, ctx.storyId) : undefined
			)
		);
	return row ?? null;
}

// The writer's live universes. The one tool that needs no universe: it is how
// an outside app finds the ids the others take.
async function listUniverses(ctx: ToolContext): Promise<string> {
	const rows = await ctx.db
		.select({
			id: universes.id,
			name: universes.name,
			description: universes.descriptionMd,
			establishedSetting: universes.establishedSetting
		})
		.from(universes)
		.where(and(eq(universes.ownerId, ctx.userId), isNull(universes.deletedAt)))
		.orderBy(asc(universes.name), asc(universes.createdAt));
	// Stories the other tools can reach: live, and not muted.
	const counts = await ctx.db
		.select({ universeId: stories.universeId, n: count() })
		.from(stories)
		.where(and(eq(stories.ownerId, ctx.userId), isNull(stories.deletedAt), storyAssistantOn()))
		.groupBy(stories.universeId);
	const storyCount = new Map(counts.map((row) => [row.universeId, row.n]));
	return JSON.stringify({
		universes: rows.map((row) => ({ ...row, storyCount: storyCount.get(row.id) ?? 0 }))
	});
}

// The stories of the universe, in series order. A muted story is left out,
// as it is from every other tool.
async function listStories(ctx: ToolContext): Promise<string> {
	const rows = await ctx.db
		.select({
			id: stories.id,
			title: stories.title,
			brief: stories.brief,
			positionInSeries: stories.positionInSeries
		})
		.from(stories)
		.where(
			and(
				eq(stories.universeId, ctx.universeId),
				eq(stories.ownerId, ctx.userId),
				isNull(stories.deletedAt),
				storyAssistantOn()
			)
		)
		.orderBy(asc(stories.positionInSeries), asc(stories.createdAt));
	const counts = rows.length
		? await ctx.db
				.select({ storyId: scenes.storyId, n: count() })
				.from(scenes)
				.where(
					and(
						inArray(
							scenes.storyId,
							rows.map((row) => row.id)
						),
						isNull(scenes.deletedAt)
					)
				)
				.groupBy(scenes.storyId)
		: [];
	const sceneCount = new Map(counts.map((row) => [row.storyId, row.n]));
	return JSON.stringify({
		stories: rows.map((row) => ({ ...row, sceneCount: sceneCount.get(row.id) ?? 0 }))
	});
}

// An entity card, but only for an entity of the context's universe. The card
// lookup is scoped to the owner alone, and an id from another of the writer's
// universes must read as a miss here like any other.
async function loadEntityCard(ctx: ToolContext, entityId: string) {
	if (!isUuid(entityId)) return null;
	const entity = await resolveOwnedEntity(ctx.db, ctx.userId, entityId, (table) => ({
		universeId: table.universeId
	}));
	if (entity?.universeId !== ctx.universeId) return null;
	return getEntityCard(ctx.db, ctx.userId, entityId);
}

// The chapter and scene skeleton for every story in the universe (or only the
// focus story under scope.storyOnly), so the model can find any scene's id and
// read it with get_scene. ctx.universeId is owner-verified by the gateway
// before any tool runs, so the skeleton query needs no further scoping.
async function listScenes(ctx: ToolContext): Promise<string> {
	const stories = await universeSkeleton(
		ctx.db,
		ctx.universeId,
		ctx.scope?.storyOnly ? (ctx.storyId ?? null) : undefined
	);
	const scene = (s: SceneSummary) => ({
		id: s.id,
		title: s.title,
		status: s.status,
		summary: s.summaryMd
	});
	return JSON.stringify({
		stories: stories.map((story) => ({
			storyId: story.storyId,
			storyTitle: story.storyTitle,
			chapters: story.chapters.map((c) => ({
				title: c.title,
				summary: c.summaryMd,
				scenes: c.scenes.map(scene)
			})),
			unfiledScenes: story.orphans.map(scene)
		}))
	});
}

async function getScene(ctx: ToolContext, sceneId: string): Promise<string> {
	const scene = await loadScene(ctx, sceneId);
	if (!scene) return 'No scene with that id in this story.';
	const cap = sceneBodyCap(ctx);
	const body =
		scene.bodyMd.length > cap
			? `${scene.bodyMd.slice(0, cap)}\n...(truncated: showing the first ${cap} of ${scene.bodyMd.length} characters)`
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
	const card = await loadEntityCard(ctx, entityId);
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
	const card = await loadEntityCard(ctx, entityId);
	if (!card) return 'No entity with that id.';
	const appearances = await entityAppearances(
		ctx.db,
		{ kind: card.kind, id: entityId },
		{ universeId: ctx.universeId },
		{ assistant: true }
	);
	return JSON.stringify(
		appearances.slice(0, MAX_APPEARANCES).map((a) => ({
			storyId: a.storyId,
			storyTitle: a.storyTitle,
			sceneId: a.sceneId,
			sceneTitle: a.sceneTitle,
			position: a.position,
			snippet: a.snippet
		}))
	);
}

async function searchText(ctx: ToolContext, query: string): Promise<string> {
	if (!query.trim()) return 'Provide a search query.';
	const results = await searchAll(ctx.db, ctx.userId, query, {
		universeId: ctx.universeId,
		assistant: true
	});
	return JSON.stringify(
		results.map((r) => ({ type: r.type, label: r.label, detail: r.sublabel, href: r.href }))
	);
}

async function suggestEdit(
	ctx: ToolContext,
	input: { sceneId: string; original: string; replacement: string; reason: string }
): Promise<ToolOutcome> {
	if (!input.original) return { result: 'Provide the exact text to replace.', staged: false };
	const limit = ctx.scope?.maxEdits;
	if (limit !== undefined && (stagedEdits.get(ctx) ?? 0) >= limit) {
		return {
			result: `Only ${limit} edit${limit === 1 ? '' : 's'} may be staged in this turn; answer now.`,
			staged: false
		};
	}
	const window = ctx.scope?.editWindow;
	if (window && window.sceneId !== input.sceneId) {
		return { result: 'Only the passage under review can be edited in this turn.', staged: false };
	}
	const scene = await loadScene(ctx, input.sceneId);
	if (!scene) return { result: 'No scene with that id in this story.', staged: false };
	const full = await overCeiling(ctx, scene.id);
	if (full) return { result: full, staged: false };
	// Tolerates a quote echoed back with the quotes or whitespace reshaped, but
	// the staged range still indexes the scene's real text (see locateQuote).
	const found = locateQuote(scene.bodyMd, input.original);
	if (!found.ok) {
		return {
			result:
				found.reason === 'ambiguous'
					? 'That passage appears more than once; include more surrounding text to make it unique.'
					: 'That exact passage was not found in the scene.',
			staged: false
		};
	}
	if (window && (found.start < window.start || found.end > window.end)) {
		return {
			result: 'That passage is outside the paragraphs under review; leave it alone.',
			staged: false
		};
	}
	const result = await createSuggestion(ctx.db, {
		// The loaded scene's own story, so a cross-story pass attributes the
		// suggestion to the right book, not the surface it was launched from.
		storyId: scene.storyId,
		sceneId: input.sceneId,
		author: stagingAuthor(ctx),
		range: { start: found.start, end: found.end },
		original: scene.bodyMd.slice(found.start, found.end),
		replacement: input.replacement,
		reason: input.reason,
		patternThreadId: ctx.scope?.patternThreadId,
		followsSuggestionId: ctx.scope?.followsSuggestionId
	});
	if (!result.ok) return { result: result.reason, staged: false };
	if (limit !== undefined) stagedEdits.set(ctx, (stagedEdits.get(ctx) ?? 0) + 1);
	return {
		result: `Staged a suggested edit (id ${result.suggestionId}). The author will accept or reject it; nothing has changed yet.`,
		staged: true,
		note: true
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
	// Checked the way the confirm step locates it, so a scene stored with
	// CRLF line endings (an older import) takes a passage across a line break.
	const location = locateSplitBefore(toLf(scene.bodyMd), toLf(input.before));
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

// The story of a thread or a suggestion an outside app names by id, but only
// when that story is the connected writer's, live, not muted, and in the
// universe of the call. In the app the calling surface fixes the target; an
// app has no surface, so the id is an argument and this check stands in.
async function reachableStory(
	ctx: ToolContext,
	table: typeof reviewThreads | typeof reviewSuggestions,
	id: string
): Promise<string | null> {
	if (!isUuid(id)) return null;
	const [row] = await ctx.db
		.select({ storyId: table.storyId })
		.from(table)
		.innerJoin(stories, eq(table.storyId, stories.id))
		.where(
			and(
				eq(table.id, id),
				eq(stories.universeId, ctx.universeId),
				eq(stories.ownerId, ctx.userId),
				isNull(stories.deletedAt),
				storyAssistantOn()
			)
		);
	return row?.storyId ?? null;
}

// The scoped reply: posts into the thread fixed by the calling surface, as
// the Assistant. No thread id crosses the model boundary. An outside app
// names the thread instead (see reachableStory), and may not answer itself:
// it replies once, then waits for someone else to write.
async function replyInThread(
	ctx: ToolContext,
	comment: string,
	threadArgument: string
): Promise<ToolOutcome> {
	let threadId = ctx.scope?.threadId;
	let storyId = ctx.storyId;
	if (ctx.external) {
		const reached = await reachableStory(ctx, reviewThreads, threadArgument);
		if (!reached) return { result: 'No thread with that id.', staged: false };
		threadId = threadArgument;
		storyId = reached;
		const [last] = await ctx.db
			.select({ clientId: reviewComments.clientId })
			.from(reviewComments)
			.where(eq(reviewComments.threadId, threadId))
			.orderBy(desc(reviewComments.createdAt))
			.limit(1);
		if (last?.clientId === ctx.external.client.id) {
			return {
				result: 'Your reply is the latest in this thread. Wait for the writer to answer.',
				staged: false
			};
		}
	}
	if (!threadId) return { result: 'There is no thread under discussion.', staged: false };
	// The scoped review tools are only offered with a story in focus; the
	// universe surface never reaches here.
	if (!storyId) return { result: 'There is no thread under discussion.', staged: false };
	if (!comment.trim()) return { result: 'Provide the reply text.', staged: false };
	const result = await addComment(ctx.db, {
		storyId,
		threadId,
		author: stagingAuthor(ctx),
		body: comment
	});
	if (!result.ok) return { result: result.reason, staged: false };
	return { result: 'Your reply was posted to the thread.', staged: true, note: true };
}

// The scoped revision: amends the Assistant's own pending suggestion fixed by
// the calling surface (or the one an outside app names, see reachableStory).
// updateAssistantSuggestion enforces authorship and the pending status.
async function updateSuggestion(
	ctx: ToolContext,
	replacement: string,
	suggestionArgument: string
): Promise<ToolOutcome> {
	let suggestionId = ctx.scope?.suggestionId;
	let storyId = ctx.storyId;
	if (ctx.external) {
		const reached = await reachableStory(ctx, reviewSuggestions, suggestionArgument);
		if (!reached) return { result: 'No suggestion with that id.', staged: false };
		suggestionId = suggestionArgument;
		storyId = reached;
	}
	if (!suggestionId || !storyId) {
		return { result: 'There is no suggestion under discussion.', staged: false };
	}
	const result = await updateAssistantSuggestion(ctx.db, {
		storyId,
		suggestionId,
		replacement,
		author: ctx.external ? stagingAuthor(ctx) : undefined
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
	const full = await overCeiling(ctx, scene.id);
	if (full) return { result: full, staged: false };
	// An anchor the same tolerant locate finds; a quote that matches nothing (or
	// several places) still leaves a whole-scene comment rather than failing.
	let anchor: { start: number; end: number } | null = null;
	if (input.quote) {
		const found = locateQuote(scene.bodyMd, input.quote);
		if (found.ok) anchor = { start: found.start, end: found.end };
	}
	const result = await createThread(ctx.db, {
		// The loaded scene's own story (see suggestEdit), not ctx.storyId.
		storyId: scene.storyId,
		sceneId: input.sceneId,
		anchor,
		author: stagingAuthor(ctx),
		body: input.comment
	});
	if (!result.ok) return { result: result.reason, staged: false };
	return {
		// An app needs the id to reply in the thread later; the Assistant's
		// thread is fixed by the page it is asked from.
		result: ctx.external
			? `Staged a review comment for the author (thread id ${result.threadId}).`
			: 'Staged a review comment for the author.',
		staged: true,
		note: true
	};
}

// The longest original echoed back in a report on edits that did not land.
const REPORT_QUOTE = 80;

// A pattern note and the edits that fix its instances, staged together and
// linked, so the writer can work through them in order (the guided pass). The
// note stages even when some edits do not locate; those are reported back so
// the model can retry them. A retry with the same comment adds to the open
// note rather than opening a second one.
// The most edits one leave_pattern_note call may carry.
const MAX_PATTERN_EDITS = 40;

async function leavePatternNote(
	ctx: ToolContext,
	input: {
		sceneId: string;
		comment: string;
		edits: { original: string; replacement: string; reason: string }[];
		kept: { quote: string; reason: string }[];
	}
): Promise<ToolOutcome> {
	// A turn confined to one note, a stretch of a scene or a number of edits
	// offers suggest_edit only; this tool would step around those limits.
	if (ctx.scope?.patternThreadId || ctx.scope?.editWindow || ctx.scope?.maxEdits !== undefined) {
		return { result: 'Use suggest_edit for this task.', staged: false };
	}
	const comment = input.comment.trim();
	if (!comment) return { result: 'Provide the note text.', staged: false };
	if (!input.edits.length) {
		return {
			result: 'Give at least one edit. For an observation with no line edits, use leave_comment.',
			staged: false
		};
	}
	const scene = await loadScene(ctx, input.sceneId);
	if (!scene) return { result: 'No scene with that id in this story.', staged: false };
	const full = await overCeiling(ctx, scene.id);
	if (full) return { result: full, staged: false };

	// Only a pattern note is extended by a retry; any other opening always starts
	// a note of its own.
	let threadId = comment.startsWith('Pattern note')
		? await openAssistantNote(ctx.db, scene.id, comment, stagingAuthor(ctx))
		: null;
	let staged = 0;
	if (!threadId) {
		// The kept list is cut to what the note has room for, so a long one
		// cannot fail the whole call.
		const heading = '\n\nLeft as is on purpose:';
		const lines: string[] = [];
		let length = comment.length + heading.length;
		for (const entry of input.kept) {
			if (!entry.quote.trim()) continue;
			const line = `\n- "${entry.quote.trim()}": ${entry.reason.trim()}`;
			if (length + line.length > MAX_COMMENT_LENGTH) break;
			lines.push(line);
			length += line.length;
		}
		const body = lines.length ? `${comment}${heading}${lines.join('')}` : comment;
		const created = await createThread(ctx.db, {
			storyId: scene.storyId,
			sceneId: scene.id,
			anchor: null,
			author: stagingAuthor(ctx),
			body
		});
		if (!created.ok) return { result: created.reason, staged: false };
		threadId = created.threadId;
		staged += 1;
	}

	const missed: string[] = [];
	let edits = 0;
	for (const edit of input.edits.slice(0, MAX_PATTERN_EDITS)) {
		const quote = edit.original.trim().slice(0, REPORT_QUOTE);
		if (!edit.original.trim()) {
			missed.push('- an edit with no original text: give the exact passage to replace');
			continue;
		}
		const found = locateQuote(scene.bodyMd, edit.original);
		if (!found.ok) {
			missed.push(
				`- "${quote}": ${found.reason === 'ambiguous' ? 'appears more than once; include more surrounding text' : 'not found in the scene'}`
			);
			continue;
		}
		const stop = await overCeiling(ctx, scene.id);
		if (stop) {
			missed.push(`- "${quote}": ${stop}`);
			continue;
		}
		const result = await createSuggestion(ctx.db, {
			storyId: scene.storyId,
			sceneId: scene.id,
			author: stagingAuthor(ctx),
			range: { start: found.start, end: found.end },
			original: scene.bodyMd.slice(found.start, found.end),
			replacement: edit.replacement,
			reason: edit.reason,
			patternThreadId: threadId
		});
		if (result.ok) edits += 1;
		else missed.push(`- "${quote}": ${result.reason}`);
	}
	if (input.edits.length > MAX_PATTERN_EDITS) {
		missed.push(
			`- ${input.edits.length - MAX_PATTERN_EDITS} more: only the first ${MAX_PATTERN_EDITS} edits of a call are read`
		);
	}
	staged += edits;
	const lines = [
		`Staged the pattern note with ${edits} linked edit${edits === 1 ? '' : 's'}. The author decides on each; nothing has changed yet.`
	];
	if (missed.length) {
		lines.push(
			'These edits were not staged:',
			...missed,
			'To retry them, call leave_pattern_note again with the same sceneId and comment and only those edits, corrected.'
		);
	}
	return { result: lines.join('\n'), staged: staged > 0, note: staged > 0, noteCount: staged };
}
