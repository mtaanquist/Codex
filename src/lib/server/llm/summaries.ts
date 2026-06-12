import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Database } from '../auth.ts';
import { chapters, scenes, stories } from '../db/schema.ts';
import { complete, type GatewayDeps } from './gateway.ts';
import { buildChapterSummaryMessage, buildSceneSummaryMessage } from './prompts/summary.ts';
import type { ChatMessage } from './providers/types.ts';

// Summary maintenance: the Assistant drafts and refreshes scene and chapter
// summary_md, the derived metadata that feeds recap and context assembly. Shared
// by the background job (the only caller for now). It proposes nothing for the
// writer to accept: a summary is generated metadata, not authored prose, so it
// is written directly - but it never overwrites a summary the writer wrote by
// hand (see needsSummary) and it preserves the row's updated_at so a summary
// write does not register as an edit or look stale on the next run.

const MAX_SUMMARY_TOKENS = 200;

export type SummaryResult = { scenes: number; chapters: number; failed: number };

function blank(value: string | null): boolean {
	return !value || !value.trim();
}

// Whether the summary job should write this summary. It fills a blank summary
// and refreshes one it generated when the source changed after the watermark;
// it leaves a non-blank summary with no watermark alone (the writer's own).
export function needsSummary(opts: {
	summaryMd: string | null;
	summaryGeneratedAt: Date | null;
	changedSince: boolean;
}): boolean {
	if (blank(opts.summaryMd)) return true;
	if (!opts.summaryGeneratedAt) return false;
	return opts.changedSince;
}

async function generate(
	db: Database,
	opts: { userId: string; storyId: string; content: string; signal?: AbortSignal },
	deps: GatewayDeps
): Promise<string> {
	const messages: ChatMessage[] = [{ role: 'user', content: opts.content }];
	const text = await complete(
		db,
		{
			userId: opts.userId,
			storyId: opts.storyId,
			role: 'chat',
			enableTools: false,
			messages,
			maxTokens: MAX_SUMMARY_TOKENS,
			signal: opts.signal
		},
		deps
	);
	return text.trim();
}

// Draft and refresh the summaries for a whole story's scenes, then its chapters
// (chapter summaries draw on the scene summaries, so scenes go first). Owner
// scoped through the story. Per-item errors are caught so one unreachable turn
// does not abandon the rest; the result reports how many summaries were written
// and how many failed.
export async function summariseStory(
	db: Database,
	opts: { userId: string; storyId: string; signal?: AbortSignal },
	deps: GatewayDeps = {}
): Promise<SummaryResult> {
	const { userId, storyId, signal } = opts;
	let written = 0;
	let chaptersWritten = 0;
	let failed = 0;
	// Chapters whose scenes changed this run, so their summary is now stale even
	// if the chapter row itself was not edited.
	const touchedChapters = new Set<string>();

	const sceneRows = await db
		.select({
			id: scenes.id,
			chapterId: scenes.chapterId,
			title: scenes.title,
			bodyMd: scenes.bodyMd,
			summaryMd: scenes.summaryMd,
			summaryGeneratedAt: scenes.summaryGeneratedAt,
			updatedAt: scenes.updatedAt
		})
		.from(scenes)
		.innerJoin(stories, eq(scenes.storyId, stories.id))
		.where(and(eq(scenes.storyId, storyId), eq(stories.ownerId, userId), isNull(scenes.deletedAt)))
		.orderBy(asc(scenes.globalPosition));

	for (const scene of sceneRows) {
		if (blank(scene.bodyMd)) continue;
		const changedSince = scene.summaryGeneratedAt
			? scene.updatedAt.getTime() > scene.summaryGeneratedAt.getTime()
			: false;
		if (
			!needsSummary({
				summaryMd: scene.summaryMd,
				summaryGeneratedAt: scene.summaryGeneratedAt,
				changedSince
			})
		) {
			continue;
		}
		try {
			const text = await generate(
				db,
				{
					userId,
					storyId,
					content: buildSceneSummaryMessage(scene.title, scene.bodyMd),
					signal
				},
				deps
			);
			if (!text) continue;
			await db
				.update(scenes)
				// Keep updated_at as it was so the summary write is not seen as an edit
				// (and so the row does not look stale next run).
				.set({ summaryMd: text, summaryGeneratedAt: new Date(), updatedAt: scene.updatedAt })
				.where(eq(scenes.id, scene.id));
			written += 1;
			if (scene.chapterId) touchedChapters.add(scene.chapterId);
		} catch (err) {
			console.error(`summaries: scene ${scene.id} failed:`, err);
			failed += 1;
		}
	}

	const chapterRows = await db
		.select({
			id: chapters.id,
			title: chapters.title,
			summaryMd: chapters.summaryMd,
			summaryGeneratedAt: chapters.summaryGeneratedAt,
			updatedAt: chapters.updatedAt
		})
		.from(chapters)
		.innerJoin(stories, eq(chapters.storyId, stories.id))
		.where(and(eq(chapters.storyId, storyId), eq(stories.ownerId, userId)))
		.orderBy(asc(chapters.position));

	for (const chapter of chapterRows) {
		const sceneSummaries = await db
			.select({ summaryMd: scenes.summaryMd })
			.from(scenes)
			.where(and(eq(scenes.chapterId, chapter.id), isNull(scenes.deletedAt)))
			.orderBy(asc(scenes.globalPosition));
		const summaries = sceneSummaries
			.map((s) => s.summaryMd?.trim())
			.filter((s): s is string => !!s);
		if (summaries.length === 0) continue;

		const changedSince =
			touchedChapters.has(chapter.id) ||
			(chapter.summaryGeneratedAt
				? chapter.updatedAt.getTime() > chapter.summaryGeneratedAt.getTime()
				: false);
		if (
			!needsSummary({
				summaryMd: chapter.summaryMd,
				summaryGeneratedAt: chapter.summaryGeneratedAt,
				changedSince
			})
		) {
			continue;
		}
		try {
			const text = await generate(
				db,
				{
					userId,
					storyId,
					content: buildChapterSummaryMessage(chapter.title, summaries),
					signal
				},
				deps
			);
			if (!text) continue;
			await db
				.update(chapters)
				.set({ summaryMd: text, summaryGeneratedAt: new Date(), updatedAt: chapter.updatedAt })
				.where(eq(chapters.id, chapter.id));
			chaptersWritten += 1;
		} catch (err) {
			console.error(`summaries: chapter ${chapter.id} failed:`, err);
			failed += 1;
		}
	}

	return { scenes: written, chapters: chaptersWritten, failed };
}
