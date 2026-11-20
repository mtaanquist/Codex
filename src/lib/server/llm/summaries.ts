import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '../auth.ts';
import { errorFields, logEvent } from '../log.ts';
import { chapters, scenes, stories } from '../db/schema.ts';
import {
	AssistantDisabledError,
	completeDetailed,
	NoModelError,
	type GatewayDeps
} from './gateway.ts';
import { buildSceneSummaryMessage } from './prompts/summary.ts';
import { spentFields, type SpendMeter } from './spend.ts';
import { jobSpendMeter } from './job-spend.ts';
import type { ChatMessage } from './providers/types.ts';
import { storyIsLive } from '../universe-scope.ts';
import { summaryIsCurrent, type SceneSummarySource } from '../summary-currency.ts';
import {
	chapterSummaryRequest,
	generatedChapterSummaryIsCurrent
} from './chapter-summary-request.ts';

// Summary maintenance: the Assistant drafts and refreshes scene and chapter
// summary_md, the derived metadata that feeds recap and context assembly. Shared
// by the background job (the only caller for now). It proposes nothing for the
// writer to accept: a summary is generated metadata, not authored prose, so it
// is written directly - but it never overwrites a summary the writer wrote by
// hand (see needsSummary), and it leaves the row's updated_at alone so a summary
// write does not register as an edit.
//
// A scene summary reads only the scene's own row, so it is current while the
// row has not changed since: it is stamped with the updated_at it was written
// from (see summary-currency.ts), and the write only lands if the row is as it
// was read before the model call.
//
// A chapter summary reads other rows (its scenes' summaries), so it is stored
// with the fingerprint of the request it was written from (summary_input) and
// is out of date when the request that would be sent now differs (see
// chapter-summary-request.ts). No save marks it.

const MAX_SUMMARY_TOKENS = 200;

export type SummaryResult = {
	scenes: number;
	chapters: number;
	failed: number;
	// Set when a run's spend ceiling was reached and the rest of the pass was
	// left for a later run, with what it had spent by then.
	capped?: boolean;
	spentUsd?: number;
	// Set when spentUsd includes estimated counts, not only reported ones.
	spentEstimated?: boolean;
	// Why a cap that was set could not be enforced. Only reported when the run
	// metered itself; a caller that passed its own meter reads it from that.
	capNotApplied?: string;
	// Set when the job was stopped part-way.
	aborted?: boolean;
	// Summaries written but not saved because the row changed while the model
	// was writing; the next run looks at them again.
	changed?: number;
	// Set when the pass stopped because no model is chosen, or the Assistant
	// is turned off: every later call would be refused the same way.
	noModel?: boolean;
	disabled?: boolean;
};

function blank(value: string | null): boolean {
	return !value || !value.trim();
}

// Whether the summary job should write this summary. It fills a blank summary
// and refreshes one it generated when what it was written from has changed; it
// leaves a non-blank summary it did not generate alone (the writer's own).
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
		messages: ChatMessage[];
		meter?: SpendMeter;
		signal?: AbortSignal;
	},
	deps: GatewayDeps
): Promise<string> {
	const result = await completeDetailed(
		db,
		{
			userId: opts.userId,
			storyId: opts.storyId,
			role: 'utility',
			enableTools: false,
			messages: opts.messages,
			maxTokens: MAX_SUMMARY_TOKENS,
			meter: opts.meter,
			signal: opts.signal
		},
		deps
	);
	return result.content.trim();
}

// Draft and refresh the summaries for a whole story's scenes, then its chapters
// (chapter summaries draw on the scene summaries, so scenes go first). Owner
// scoped through the story. A review passes the meter it shares across its
// phases; called on its own, the run meters itself against the account's cap.
// Per-item errors are caught so one unreachable turn does not abandon the rest;
// the result reports how many summaries were written and how many failed.
export async function summariseStory(
	db: Database,
	opts: {
		userId: string;
		storyId: string;
		meter?: SpendMeter;
		// The queued job's id, so a retry carries on from what it already spent.
		jobId?: string;
		signal?: AbortSignal;
	},
	deps: GatewayDeps = {}
): Promise<SummaryResult> {
	const { userId, storyId, signal } = opts;
	const ownMeter = !opts.meter;
	const meter = opts.meter ?? (await jobSpendMeter(db, { userId, storyId, jobId: opts.jobId }));
	let written = 0;
	let chaptersWritten = 0;
	let failed = 0;
	let capped = false;
	let changed = 0;
	let noModel = false;
	let disabled = false;
	// The gate refusal ends the pass; anything else is one item's failure.
	const stopsPass = (err: unknown): boolean => {
		if (err instanceof NoModelError) noModel = true;
		else if (err instanceof AssistantDisabledError) disabled = true;
		else return false;
		return true;
	};
	const sceneRows = await db
		.select({
			id: scenes.id,
			title: scenes.title,
			bodyMd: scenes.bodyMd,
			summaryMd: scenes.summaryMd,
			summaryGeneratedAt: scenes.summaryGeneratedAt,
			updatedAt: scenes.updatedAt,
			// As text, so the write below compares to the microsecond.
			updatedAtText: sql<string>`${scenes.updatedAt}::text`,
			generatedAtText: sql<string | null>`${scenes.summaryGeneratedAt}::text`
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
		if (signal?.aborted) break;
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
					messages: [
						{ role: 'user', content: buildSceneSummaryMessage(scene.title, scene.bodyMd) }
					],
					meter,
					signal
				},
				deps
			);
			if (!text) continue;
			// Raw SQL so updated_at's $onUpdate does not fire. A scene edited, or
			// given a summary, since it was read keeps what it has; the next run
			// looks at it again. The chapter's summary and the arcs that read this
			// one need no telling: their requests no longer match.
			const { rows } = await db.execute(sql`
				update scenes set summary_md = ${text}, summary_generated_at = updated_at
				where id = ${scene.id}
					and updated_at = ${scene.updatedAtText}::timestamptz
					and summary_md is not distinct from ${scene.summaryMd}
					and summary_generated_at is not distinct from ${scene.generatedAtText}::timestamptz
					and deleted_at is null
				returning id
			`);
			const stored = rows.length > 0;
			if (!stored) {
				changed += 1;
				continue;
			}
			written += 1;
		} catch (err) {
			if (stopsPass(err)) break;
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
			summaryInput: chapters.summaryInput,
			// As text, so the write below compares to the microsecond.
			generatedAtText: sql<string | null>`${chapters.summaryGeneratedAt}::text`
		})
		.from(chapters)
		.innerJoin(stories, eq(chapters.storyId, stories.id))
		.where(and(eq(chapters.storyId, storyId), eq(stories.ownerId, userId), storyIsLive()))
		.orderBy(asc(chapters.position));

	// Every chapter's scene summaries in one read, read after the scene pass so
	// the summaries it just wrote are included.
	const summariesByChapter = new Map<string, SceneSummarySource[]>();
	if (chapterRows.length > 0) {
		const sceneSummaries = await db
			.select({
				chapterId: scenes.chapterId,
				summaryMd: scenes.summaryMd,
				summaryGeneratedAt: scenes.summaryGeneratedAt,
				updatedAt: scenes.updatedAt
			})
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
			if (!row.chapterId) continue;
			const list = summariesByChapter.get(row.chapterId) ?? [];
			list.push(row);
			summariesByChapter.set(row.chapterId, list);
		}
	}

	for (const chapter of noModel || disabled ? [] : chapterRows) {
		if (signal?.aborted) break;
		if (meter.capReached) {
			capped = true;
			break;
		}
		const request = chapterSummaryRequest(chapter.title, summariesByChapter.get(chapter.id) ?? []);
		if (!request) continue;
		if (
			!needsSummary({
				summaryMd: chapter.summaryMd,
				summaryGeneratedAt: chapter.summaryGeneratedAt,
				changedSince: !generatedChapterSummaryIsCurrent(chapter, request)
			})
		) {
			continue;
		}
		try {
			const text = await generate(
				db,
				{ userId, storyId, messages: request.messages, meter, signal },
				deps
			);
			if (!text) continue;
			// Stored with the fingerprint of the request that was sent, so a scene
			// added, removed, moved or summarised again while the model was writing
			// leaves the summary out of date. The checks keep a summary the writer
			// typed meanwhile.
			const { rows } = await db.execute(sql`
				update chapters
				set summary_md = ${text}, summary_generated_at = now(), summary_input = ${request.input}
				where id = ${chapter.id}
					and summary_md is not distinct from ${chapter.summaryMd}
					and summary_generated_at is not distinct from ${chapter.generatedAtText}::timestamptz
				returning id
			`);
			if (rows.length > 0) chaptersWritten += 1;
			else changed += 1;
		} catch (err) {
			if (stopsPass(err)) break;
			logEvent('error', 'summaries.chapter_failed', { chapterId: chapter.id, ...errorFields(err) });
			failed += 1;
		}
	}

	if (ownMeter) await meter.flush();
	return {
		scenes: written,
		chapters: chaptersWritten,
		failed,
		...(signal?.aborted ? { aborted: true } : {}),
		...(capped ? { capped: true, ...spentFields(meter) } : {}),
		...(changed ? { changed } : {}),
		...(noModel ? { noModel: true } : {}),
		...(disabled ? { disabled: true } : {}),
		...(ownMeter && meter.notApplied ? { capNotApplied: meter.notAppliedMessage } : {})
	};
}
