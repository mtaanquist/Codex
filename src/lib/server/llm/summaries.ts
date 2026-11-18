import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '../auth.ts';
import { errorFields, logEvent } from '../log.ts';
import { chapters, scenes, stories } from '../db/schema.ts';
import { completeDetailed, type GatewayDeps } from './gateway.ts';
import { buildChapterSummaryMessage, buildSceneSummaryMessage } from './prompts/summary.ts';
import { resolveLlmConfig } from './config.ts';
import { SpendMeter } from './spend.ts';
import type { ChatMessage } from './providers/types.ts';
import { storyIsLive } from '../universe-scope.ts';
import { markMentionsStale } from '../scene-lifecycle.ts';
import { summaryIsCurrent } from '../summary-currency.ts';

// Summary maintenance: the Assistant drafts and refreshes scene and chapter
// summary_md, the derived metadata that feeds recap and context assembly. Shared
// by the background job (the only caller for now). It proposes nothing for the
// writer to accept: a summary is generated metadata, not authored prose, so it
// is written directly - but it never overwrites a summary the writer wrote by
// hand (see needsSummary), and it leaves the row's updated_at alone so a summary
// write does not register as an edit or look stale on the next run. The write
// only lands if the row is as it was read before the model call, so a summary
// typed or an edit made while the model was writing is kept.

const MAX_SUMMARY_TOKENS = 200;

export type SummaryResult = {
	scenes: number;
	chapters: number;
	failed: number;
	// Set when a run's spend ceiling was reached and the rest of the pass was
	// left for a later run, with what it had spent by then.
	capped?: boolean;
	spentUsd?: number;
	// Why a cap that was set could not be enforced. Only reported when the run
	// metered itself; a caller that passed its own meter reads it from that.
	capNotApplied?: string;
};

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
	opts: {
		userId: string;
		storyId: string;
		content: string;
		meter?: SpendMeter;
		signal?: AbortSignal;
	},
	deps: GatewayDeps
): Promise<string> {
	const messages: ChatMessage[] = [{ role: 'user', content: opts.content }];
	const result = await completeDetailed(
		db,
		{
			userId: opts.userId,
			storyId: opts.storyId,
			role: 'utility',
			enableTools: false,
			messages,
			maxTokens: MAX_SUMMARY_TOKENS,
			meter: opts.meter,
			signal: opts.signal
		},
		deps
	);
	return result.content.trim();
}

async function storyMeter(db: Database, userId: string, storyId: string): Promise<SpendMeter> {
	const resolved = await resolveLlmConfig(db, userId, storyId);
	return new SpendMeter({
		pricing: resolved.config.modelPricing,
		capUsd: resolved.config.spendCapUsd
	});
}

// Draft and refresh the summaries for a whole story's scenes, then its chapters
// (chapter summaries draw on the scene summaries, so scenes go first). Owner
// scoped through the story. A review passes the meter it shares across its
// phases; called on its own, the run meters itself against the account's cap.
// Per-item errors are caught so one unreachable turn does not abandon the rest;
// the result reports how many summaries were written and how many failed.
export async function summariseStory(
	db: Database,
	opts: { userId: string; storyId: string; meter?: SpendMeter; signal?: AbortSignal },
	deps: GatewayDeps = {}
): Promise<SummaryResult> {
	const { userId, storyId, signal } = opts;
	const ownMeter = !opts.meter;
	const meter = opts.meter ?? (await storyMeter(db, userId, storyId));
	let written = 0;
	let chaptersWritten = 0;
	let failed = 0;
	let capped = false;
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
			updatedAt: scenes.updatedAt,
			// As text, so the write below compares to the microsecond.
			updatedAtText: sql<string>`${scenes.updatedAt}::text`
		})
		.from(scenes)
		.innerJoin(stories, eq(scenes.storyId, stories.id))
		.where(
			and(
				eq(scenes.storyId, storyId),
				eq(stories.ownerId, userId),
				storyIsLive(),
				isNull(scenes.deletedAt)
			)
		)
		.orderBy(asc(scenes.globalPosition));

	for (const scene of sceneRows) {
		// Between summaries is the boundary where stopping leaves nothing partial.
		if (meter.capReached) {
			capped = true;
			break;
		}
		if (blank(scene.bodyMd)) continue;
		const changedSince = scene.summaryGeneratedAt
			? !summaryIsCurrent(scene.summaryGeneratedAt, scene.updatedAt)
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
					meter,
					signal
				},
				deps
			);
			if (!text) continue;
			const stored = await db.transaction(async (tx) => {
				// Raw SQL so updated_at's $onUpdate does not fire. A scene edited, or
				// given a summary, since it was read keeps what it has; the next run
				// looks at it again.
				const { rows } = await tx.execute(sql`
					update scenes set summary_md = ${text}, summary_generated_at = now()
					where id = ${scene.id}
						and updated_at = ${scene.updatedAtText}::timestamptz
						and summary_md is not distinct from ${scene.summaryMd}
						and deleted_at is null
					returning id
				`);
				if (rows.length === 0) return false;
				// Character arcs read scene summaries.
				await markMentionsStale(tx, { sceneIds: [scene.id] });
				return true;
			});
			if (!stored) continue;
			written += 1;
			if (scene.chapterId) touchedChapters.add(scene.chapterId);
		} catch (err) {
			logEvent('error', 'summaries.scene_failed', { sceneId: scene.id, ...errorFields(err) });
			failed += 1;
		}
	}

	const chapterRows = await db
		.select({
			id: chapters.id,
			title: chapters.title,
			summaryMd: chapters.summaryMd,
			summaryGeneratedAt: chapters.summaryGeneratedAt,
			updatedAt: chapters.updatedAt,
			updatedAtText: sql<string>`${chapters.updatedAt}::text`
		})
		.from(chapters)
		.innerJoin(stories, eq(chapters.storyId, stories.id))
		.where(and(eq(chapters.storyId, storyId), eq(stories.ownerId, userId), storyIsLive()))
		.orderBy(asc(chapters.position));

	// Every chapter's scene summaries in one read, read after the scene pass so
	// the summaries it just wrote are included.
	const summariesByChapter = new Map<string, string[]>();
	if (chapterRows.length > 0) {
		const sceneSummaries = await db
			.select({ chapterId: scenes.chapterId, summaryMd: scenes.summaryMd })
			.from(scenes)
			.where(
				and(
					inArray(
						scenes.chapterId,
						chapterRows.map((c) => c.id)
					),
					isNull(scenes.deletedAt)
				)
			)
			.orderBy(asc(scenes.globalPosition));
		for (const row of sceneSummaries) {
			const summary = row.summaryMd?.trim();
			if (!row.chapterId || !summary) continue;
			const list = summariesByChapter.get(row.chapterId) ?? [];
			list.push(summary);
			summariesByChapter.set(row.chapterId, list);
		}
	}

	for (const chapter of chapterRows) {
		if (meter.capReached) {
			capped = true;
			break;
		}
		const summaries = summariesByChapter.get(chapter.id) ?? [];
		if (summaries.length === 0) continue;

		const changedSince =
			touchedChapters.has(chapter.id) ||
			(chapter.summaryGeneratedAt
				? !summaryIsCurrent(chapter.summaryGeneratedAt, chapter.updatedAt)
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
					meter,
					signal
				},
				deps
			);
			if (!text) continue;
			// As for scenes: only over the chapter as it was read.
			const { rows } = await db.execute(sql`
				update chapters set summary_md = ${text}, summary_generated_at = now()
				where id = ${chapter.id}
					and updated_at = ${chapter.updatedAtText}::timestamptz
					and summary_md is not distinct from ${chapter.summaryMd}
				returning id
			`);
			if (rows.length > 0) chaptersWritten += 1;
		} catch (err) {
			logEvent('error', 'summaries.chapter_failed', { chapterId: chapter.id, ...errorFields(err) });
			failed += 1;
		}
	}

	return {
		scenes: written,
		chapters: chaptersWritten,
		failed,
		...(capped ? { capped: true, spentUsd: meter.spentUsd } : {}),
		...(ownMeter && meter.notApplied ? { capNotApplied: meter.notAppliedMessage } : {})
	};
}
