import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../auth.ts';
import {
	reviewComments,
	reviewSuggestions,
	reviewThreads,
	revisions,
	scenes,
	stories
} from '../db/schema.ts';
import { assembleContext, buildSystemMessage } from './context/assemble.ts';
import {
	buildConsistencyMessage,
	buildReviewMessage,
	buildUniverseConsistencyMessage,
	type PriorNote
} from './prompts/review.ts';
import { isFullReview, type ReviewCategory } from '../../review-shape.ts';
import { complete, type GatewayDeps } from './gateway.ts';
import type { ChatMessage } from './providers/types.ts';

// Tool budgets for the exhaustive passes. A focused or full pass stages one
// tool call per note plus the scene read, so the account's conservative
// default would cut it off mid-review; the consistency pass must read every
// scene before it can compare anything. The gateway clamps both to its own
// ceiling.
const FOCUSED_PASS_BUDGET = 64;
function consistencyBudget(sceneCount: number): number {
	return sceneCount * 2 + 24;
}

// The Assistant-as-reviewer run, shared by the inline single-scene endpoint and
// the whole-story / chapter background job. It assembles the scene's context,
// asks the reviewer to leave its notes through the staging tools, and runs the
// gateway. Nothing here touches the prose: suggest_edit / leave_comment stage
// review suggestions and comments the author later accepts or rejects.

// The Assistant's pending notes on a scene, for reporting how many a run added.
export async function countAssistantNotes(db: Database, sceneId: string): Promise<number> {
	const [suggestions] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(reviewSuggestions)
		.where(
			and(
				eq(reviewSuggestions.sceneId, sceneId),
				eq(reviewSuggestions.assistant, true),
				eq(reviewSuggestions.status, 'pending')
			)
		);
	const [comments] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(reviewComments)
		.innerJoin(reviewThreads, eq(reviewComments.threadId, reviewThreads.id))
		.where(and(eq(reviewThreads.sceneId, sceneId), eq(reviewComments.assistant, true)));
	return (suggestions?.n ?? 0) + (comments?.n ?? 0);
}

// The Assistant's still-open notes on a scene, carried into the next review
// run so it does not stage the same observations twice: its comments on
// unresolved standalone threads, and its pending suggestions with the passage
// each was anchored to.
export async function openAssistantNotes(db: Database, sceneId: string): Promise<PriorNote[]> {
	const comments = await db
		.select({ body: reviewComments.bodyMd, createdAt: reviewComments.createdAt })
		.from(reviewComments)
		.innerJoin(reviewThreads, eq(reviewComments.threadId, reviewThreads.id))
		.where(
			and(
				eq(reviewThreads.sceneId, sceneId),
				isNull(reviewThreads.resolvedAt),
				isNull(reviewThreads.suggestionId),
				eq(reviewComments.assistant, true)
			)
		)
		.orderBy(asc(reviewComments.createdAt));
	const suggestions = await db
		.select({
			rangeStart: reviewSuggestions.rangeStart,
			rangeEnd: reviewSuggestions.rangeEnd,
			replacement: reviewSuggestions.replacement,
			baseBody: revisions.bodyMd,
			createdAt: reviewSuggestions.createdAt
		})
		.from(reviewSuggestions)
		.innerJoin(revisions, eq(reviewSuggestions.baseRevisionId, revisions.id))
		.where(
			and(
				eq(reviewSuggestions.sceneId, sceneId),
				eq(reviewSuggestions.assistant, true),
				eq(reviewSuggestions.status, 'pending')
			)
		)
		.orderBy(asc(reviewSuggestions.createdAt));
	return [
		...comments.map((c) => ({ kind: 'comment' as const, body: c.body })),
		...suggestions.map((s) => ({
			kind: 'suggestion' as const,
			quote: s.baseBody.slice(s.rangeStart, s.rangeEnd),
			body: s.replacement
		}))
	];
}

// One scene through the reviewer. Throws if the gateway fails (no endpoint,
// unreachable, disabled), so the caller can report it.
export async function reviewOneScene(
	db: Database,
	opts: {
		userId: string;
		storyId: string;
		scene: { id: string; title: string | null };
		categories?: ReviewCategory[];
		signal?: AbortSignal;
	},
	deps: GatewayDeps = {}
): Promise<void> {
	const context = await assembleContext(db, {
		userId: opts.userId,
		storyId: opts.storyId,
		sceneId: opts.scene.id
	});
	const prior = await openAssistantNotes(db, opts.scene.id);
	const categories = opts.categories ?? [];
	const task: ChatMessage = {
		role: 'user',
		content: buildReviewMessage(opts.scene, prior, categories)
	};
	const messages: ChatMessage[] = context
		? [buildSystemMessage(context, { tools: true }), task]
		: [task];
	await complete(
		db,
		{
			userId: opts.userId,
			storyId: opts.storyId,
			role: 'reviewer',
			enableTools: true,
			messages,
			...(categories.length === 0 ? {} : { toolBudget: FOCUSED_PASS_BUDGET }),
			signal: opts.signal
		},
		deps
	);
}

// The shared body of every consistency pass: assemble the scope's world
// context, hand the model the consistency task, and run the gateway with tools
// and a budget that lets it read every scene before comparing. The scope drives
// both the assembled context and the gateway's retrieval reach (a story focus,
// or the whole universe). Throws on gateway failure, like reviewOneScene.
async function runConsistencyPass(
	db: Database,
	opts: {
		userId: string;
		scope: { storyId: string } | { universeId: string };
		message: string;
		sceneCount: number;
		signal?: AbortSignal;
	},
	deps: GatewayDeps = {}
): Promise<void> {
	const context = await assembleContext(db, {
		userId: opts.userId,
		...('storyId' in opts.scope
			? { storyId: opts.scope.storyId }
			: { universeId: opts.scope.universeId })
	});
	const task: ChatMessage = { role: 'user', content: opts.message };
	const messages: ChatMessage[] = context
		? [buildSystemMessage(context, { tools: true }), task]
		: [task];
	await complete(
		db,
		{
			userId: opts.userId,
			...('storyId' in opts.scope
				? { storyId: opts.scope.storyId }
				: { universeId: opts.scope.universeId }),
			role: 'reviewer',
			enableTools: true,
			messages,
			toolBudget: consistencyBudget(opts.sceneCount),
			signal: opts.signal
		},
		deps
	);
}

// The cross-scene pass of a full story review: one run over every scene,
// looking only for issues that span scenes. Anchors its notes like any other
// review note. Throws on gateway failure, like reviewOneScene.
export async function reviewStoryConsistency(
	db: Database,
	opts: {
		userId: string;
		storyId: string;
		scenes: { id: string; title: string | null }[];
		signal?: AbortSignal;
	},
	deps: GatewayDeps = {}
): Promise<void> {
	await runConsistencyPass(
		db,
		{
			userId: opts.userId,
			scope: { storyId: opts.storyId },
			message: buildConsistencyMessage(opts.scenes),
			sceneCount: opts.scenes.length,
			signal: opts.signal
		},
		deps
	);
}

// How a standalone continuity review went: how many scenes were in scope, how
// many notes it staged, and whether the pass ran at all (it is skipped when
// there is nothing to compare, fewer than two scenes).
export type ContinuityReviewResult = { scenes: number; notes: number; ran: boolean };

// Tallies the notes a continuity pass staged across a set of scenes, by diffing
// the per-scene assistant-note counts around the run.
async function countDelta(
	db: Database,
	sceneIds: string[],
	run: () => Promise<void>
): Promise<number> {
	const before = await Promise.all(sceneIds.map((id) => countAssistantNotes(db, id)));
	await run();
	const after = await Promise.all(sceneIds.map((id) => countAssistantNotes(db, id)));
	return after.reduce((sum, n, i) => sum + Math.max(0, n - before[i]), 0);
}

// A standalone story continuity review: the consistency pass on its own, with
// no per-scene copyedit passes before it. Reuses reviewStoryConsistency over
// every non-deleted scene in the story, owner-scoped. Skipped when the story has
// fewer than two scenes (nothing spans).
export async function reviewStoryContinuity(
	db: Database,
	opts: { userId: string; storyId: string; signal?: AbortSignal },
	deps: GatewayDeps = {}
): Promise<ContinuityReviewResult> {
	const targets = await db
		.select({ id: scenes.id, title: scenes.title })
		.from(scenes)
		.innerJoin(stories, eq(scenes.storyId, stories.id))
		.where(
			and(
				eq(scenes.storyId, opts.storyId),
				eq(stories.ownerId, opts.userId),
				isNull(scenes.deletedAt)
			)
		)
		.orderBy(asc(scenes.globalPosition));
	if (targets.length < 2) return { scenes: targets.length, notes: 0, ran: false };
	const notes = await countDelta(
		db,
		targets.map((s) => s.id),
		() =>
			reviewStoryConsistency(
				db,
				{ userId: opts.userId, storyId: opts.storyId, scenes: targets, signal: opts.signal },
				deps
			)
	);
	return { scenes: targets.length, notes, ran: true };
}

// A universe-wide continuity review: one pass across every story in the
// universe, looking for facts that contradict each other between books. The
// universe-scoped tools reach any story, and leave_comment resolves a scene's
// own owning story, so a contradiction found in one story anchors there even
// though the pass was launched at the universe. Skipped when the universe holds
// fewer than two scenes.
export async function reviewUniverseContinuity(
	db: Database,
	opts: { userId: string; universeId: string; signal?: AbortSignal },
	deps: GatewayDeps = {}
): Promise<ContinuityReviewResult> {
	const rows = await db
		.select({
			sceneId: scenes.id,
			sceneTitle: scenes.title,
			storyId: stories.id,
			storyTitle: stories.title
		})
		.from(scenes)
		.innerJoin(stories, eq(scenes.storyId, stories.id))
		.where(
			and(
				eq(stories.universeId, opts.universeId),
				eq(stories.ownerId, opts.userId),
				isNull(scenes.deletedAt)
			)
		)
		.orderBy(asc(stories.title), asc(scenes.globalPosition));
	if (rows.length < 2) return { scenes: rows.length, notes: 0, ran: false };

	// Group the scenes under their story, preserving the query's order.
	const byStory = new Map<
		string,
		{ storyTitle: string; scenes: { id: string; title: string | null }[] }
	>();
	for (const row of rows) {
		let group = byStory.get(row.storyId);
		if (!group) {
			group = { storyTitle: row.storyTitle, scenes: [] };
			byStory.set(row.storyId, group);
		}
		group.scenes.push({ id: row.sceneId, title: row.sceneTitle });
	}

	const notes = await countDelta(
		db,
		rows.map((r) => r.sceneId),
		() =>
			runConsistencyPass(
				db,
				{
					userId: opts.userId,
					scope: { universeId: opts.universeId },
					message: buildUniverseConsistencyMessage([...byStory.values()]),
					sceneCount: rows.length,
					signal: opts.signal
				},
				deps
			)
	);
	return { scenes: rows.length, notes, ran: true };
}

export type StoryReviewResult = { reviewed: number; failed: number; notes: number };

// A whole-story or single-chapter review: every non-deleted scene in scope,
// owner-scoped through the story. Errors on one scene are caught so a single
// unreachable turn does not abandon the rest; the result reports how many
// scenes were reviewed, how many failed, and how many notes were staged.
export async function reviewStoryScenes(
	db: Database,
	opts: {
		userId: string;
		storyId: string;
		chapterId?: string;
		categories?: ReviewCategory[];
		signal?: AbortSignal;
	},
	deps: GatewayDeps = {}
): Promise<StoryReviewResult> {
	const where = [
		eq(scenes.storyId, opts.storyId),
		eq(stories.ownerId, opts.userId),
		isNull(scenes.deletedAt)
	];
	if (opts.chapterId) where.push(eq(scenes.chapterId, opts.chapterId));
	const targets = await db
		.select({ id: scenes.id, title: scenes.title })
		.from(scenes)
		.innerJoin(stories, eq(scenes.storyId, stories.id))
		.where(and(...where))
		.orderBy(asc(scenes.globalPosition));

	let reviewed = 0;
	let failed = 0;
	let notes = 0;
	for (const scene of targets) {
		const before = await countAssistantNotes(db, scene.id);
		try {
			await reviewOneScene(
				db,
				{
					userId: opts.userId,
					storyId: opts.storyId,
					scene,
					categories: opts.categories,
					signal: opts.signal
				},
				deps
			);
			reviewed += 1;
			notes += (await countAssistantNotes(db, scene.id)) - before;
		} catch {
			failed += 1;
		}
	}
	// A full review ends with one cross-scene pass: the only run that can see
	// drift between scenes (names, timelines, idiom conventions). Pointless
	// for a single scene, and skipped when every per-scene pass failed.
	if (isFullReview(opts.categories ?? []) && targets.length > 1 && reviewed > 0) {
		const counts = await Promise.all(targets.map((scene) => countAssistantNotes(db, scene.id)));
		try {
			await reviewStoryConsistency(
				db,
				{ userId: opts.userId, storyId: opts.storyId, scenes: targets, signal: opts.signal },
				deps
			);
			const after = await Promise.all(targets.map((scene) => countAssistantNotes(db, scene.id)));
			notes += after.reduce((sum, n, i) => sum + Math.max(0, n - counts[i]), 0);
		} catch {
			failed += 1;
		}
	}
	return { reviewed, failed, notes };
}
