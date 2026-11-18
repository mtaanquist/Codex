import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import type { Database } from './auth.ts';
import { chapters, stories, universes } from './db/schema.ts';
import { ASSISTANT_REVIEW_QUEUE, ASSISTANT_SUMMARIES_QUEUE } from './queues.ts';

// The writer's Assistant jobs that have not settled yet, so a page that loads
// mid-run can pick them up again: the activity center resumes their cards and
// the story's mode strip shows the run. The browser only remembers a job it
// started itself, and forgets it on reload.

export type RunningAssistantJob = {
	id: string;
	kind: 'review' | 'summaries';
	mode: 'full' | 'continuity';
	storyId: string | null;
	chapterId: string | null;
	universeId: string | null;
	// The story, chapter or universe name, for the card's label.
	title: string;
};

type JobData = {
	userId?: string;
	storyId?: string;
	chapterId?: string;
	universeId?: string;
	mode?: 'full' | 'continuity';
};

// pg-boss keeps settled jobs for a while; these are the states still to run.
const UNSETTLED = new Set(['created', 'retry', 'active']);

export async function findRunningAssistantJobs(
	boss: Pick<PgBoss, 'findJobs'>,
	db: Database,
	userId: string
): Promise<RunningAssistantJob[]> {
	const found: { id: string; kind: 'review' | 'summaries'; data: JobData }[] = [];
	for (const [kind, queue] of [
		['review', ASSISTANT_REVIEW_QUEUE],
		['summaries', ASSISTANT_SUMMARIES_QUEUE]
	] as const) {
		const jobs = await boss.findJobs<JobData>(queue, { data: { userId } });
		for (const job of jobs) {
			if (UNSETTLED.has(job.state)) found.push({ id: job.id, kind, data: job.data });
		}
	}
	if (found.length === 0) return [];

	// Names come from the writer's own live stories and universes, so a job over
	// something since deleted (or no longer theirs) is left out.
	const storyIds = [...new Set(found.flatMap((j) => (j.data.storyId ? [j.data.storyId] : [])))];
	const universeIds = [
		...new Set(found.flatMap((j) => (j.data.universeId ? [j.data.universeId] : [])))
	];
	const chapterIds = [
		...new Set(found.flatMap((j) => (j.data.chapterId ? [j.data.chapterId] : [])))
	];
	const storyTitles = new Map(
		storyIds.length
			? (
					await db
						.select({ id: stories.id, title: stories.title })
						.from(stories)
						.innerJoin(universes, eq(stories.universeId, universes.id))
						.where(
							and(
								inArray(stories.id, storyIds),
								eq(stories.ownerId, userId),
								isNull(stories.deletedAt),
								isNull(universes.deletedAt)
							)
						)
				).map((r) => [r.id, r.title])
			: []
	);
	const universeNames = new Map(
		universeIds.length
			? (
					await db
						.select({ id: universes.id, name: universes.name })
						.from(universes)
						.where(
							and(
								inArray(universes.id, universeIds),
								eq(universes.ownerId, userId),
								isNull(universes.deletedAt)
							)
						)
				).map((r) => [r.id, r.name])
			: []
	);
	const chapterTitles = new Map(
		chapterIds.length
			? (
					await db
						.select({ id: chapters.id, storyId: chapters.storyId, title: chapters.title })
						.from(chapters)
						.where(inArray(chapters.id, chapterIds))
				).map((r) => [r.id, r])
			: []
	);

	const out: RunningAssistantJob[] = [];
	for (const job of found) {
		const { storyId, chapterId, universeId } = job.data;
		let title: string | undefined;
		if (universeId) {
			title = universeNames.get(universeId);
		} else if (storyId) {
			title = storyTitles.get(storyId);
			const chapter = chapterId ? chapterTitles.get(chapterId) : undefined;
			if (title !== undefined && chapter?.storyId === storyId && chapter.title) {
				title = chapter.title;
			}
		}
		if (title === undefined) continue;
		out.push({
			id: job.id,
			kind: job.kind,
			mode: job.data.mode === 'continuity' ? 'continuity' : 'full',
			storyId: universeId ? null : (storyId ?? null),
			chapterId: universeId ? null : (chapterId ?? null),
			universeId: universeId ?? null,
			title
		});
	}
	return out;
}
