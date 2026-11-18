import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
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

// Reads pg-boss's job table directly (the default "pgboss" schema the app and
// worker use). Its findJobs has no state filter and returns the oldest rows
// first, capped, and settled jobs stay in the table for days, so a busy writer's
// running job could fall past the cap. The integration test pins this query to
// the installed pg-boss.
export async function findRunningAssistantJobs(
	db: Database,
	userId: string
): Promise<RunningAssistantJob[]> {
	const { rows } = await db.execute<{ id: string; name: string; data: JobData }>(sql`
		select id, name, data from pgboss.job
		where name in (${ASSISTANT_REVIEW_QUEUE}, ${ASSISTANT_SUMMARIES_QUEUE})
			and state in ('created', 'retry', 'active')
			and data @> ${JSON.stringify({ userId })}::jsonb
		order by created_on
		limit 100
	`);
	const found = rows.map((row) => ({
		id: row.id,
		kind: (row.name === ASSISTANT_SUMMARIES_QUEUE ? 'summaries' : 'review') as
			'review' | 'summaries',
		data: row.data
	}));
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
				title = `${title}: ${chapter.title}`;
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
