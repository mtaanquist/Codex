import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../auth';
import { reviewComments, reviewSuggestions, reviewThreads, scenes, stories } from '../db/schema';
import { assembleContext, buildSystemMessage } from './context/assemble';
import { buildReviewMessage } from './prompts/review';
import { complete } from './gateway';
import type { ChatMessage } from './providers/types';

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

// One scene through the reviewer. Throws if the gateway fails (no endpoint,
// unreachable, disabled), so the caller can report it.
export async function reviewOneScene(
	db: Database,
	opts: {
		userId: string;
		storyId: string;
		scene: { id: string; title: string | null };
		signal?: AbortSignal;
	}
): Promise<void> {
	const context = await assembleContext(db, {
		userId: opts.userId,
		storyId: opts.storyId,
		sceneId: opts.scene.id
	});
	const task: ChatMessage = { role: 'user', content: buildReviewMessage(opts.scene) };
	const messages: ChatMessage[] = context ? [buildSystemMessage(context), task] : [task];
	await complete(db, {
		userId: opts.userId,
		storyId: opts.storyId,
		role: 'reviewer',
		enableTools: true,
		messages,
		signal: opts.signal
	});
}

export type StoryReviewResult = { reviewed: number; failed: number; notes: number };

// A whole-story or single-chapter review: every non-deleted scene in scope,
// owner-scoped through the story. Errors on one scene are caught so a single
// unreachable turn does not abandon the rest; the result reports how many
// scenes were reviewed, how many failed, and how many notes were staged.
export async function reviewStoryScenes(
	db: Database,
	opts: { userId: string; storyId: string; chapterId?: string; signal?: AbortSignal }
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
			await reviewOneScene(db, {
				userId: opts.userId,
				storyId: opts.storyId,
				scene,
				signal: opts.signal
			});
			reviewed += 1;
			notes += (await countAssistantNotes(db, scene.id)) - before;
		} catch {
			failed += 1;
		}
	}
	return { reviewed, failed, notes };
}
