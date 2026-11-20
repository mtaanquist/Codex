import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import type { Database } from './auth.ts';
import { isUuid } from '../slug.ts';
import { chapters, characters, stories, universes } from './db/schema.ts';
import {
	ASSISTANT_ENRICH_QUEUE,
	ASSISTANT_REVIEW_QUEUE,
	ASSISTANT_SUMMARIES_QUEUE,
	LEGACY_ASSISTANT_REVIEW_QUEUE,
	LEGACY_ASSISTANT_SUMMARIES_QUEUE
} from './queues.ts';

// The writer's Assistant jobs that have not settled yet, so a page that loads
// mid-run can pick them up again: the activity center resumes their cards and
// the story's mode strip shows the run. The browser only remembers a job it
// started itself, and forgets it on reload. LEGACY (#1041): the old review and
// summaries queues are read too, for jobs queued before the upgrade.

export type RunningAssistantJob = {
	id: string;
	kind: 'review' | 'summaries' | 'enrich' | 'arc' | 'details';
	mode: 'full' | 'continuity';
	storyId: string | null;
	chapterId: string | null;
	universeId: string | null;
	// The story, chapter or universe name, for the card's label.
	title: string;
	// When the job was queued, for how long it has been going.
	startedAt: string;
};

type JobData = {
	userId?: string;
	storyId?: string;
	chapterId?: string;
	universeId?: string;
	characterId?: string;
	// A full-text read of one entity (the "Suggest details" button).
	read?: { entityId?: string; name?: string };
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
	const { rows } = await db.execute<{
		id: string;
		name: string;
		data: JobData;
		created_on: Date | string;
	}>(sql`
		select id, name, data, created_on from pgboss.job
		where name in (
			${ASSISTANT_REVIEW_QUEUE}, ${ASSISTANT_SUMMARIES_QUEUE}, ${ASSISTANT_ENRICH_QUEUE},
			${LEGACY_ASSISTANT_REVIEW_QUEUE}, ${LEGACY_ASSISTANT_SUMMARIES_QUEUE}
		)
			and state in ('created', 'retry', 'active')
			and data @> ${JSON.stringify({ userId })}::jsonb
		order by created_on
		limit 100
	`);
	const found = rows.map((row) => ({
		id: row.id,
		kind:
			row.name === ASSISTANT_SUMMARIES_QUEUE || row.name === LEGACY_ASSISTANT_SUMMARIES_QUEUE
				? ('summaries' as const)
				: row.name === ASSISTANT_ENRICH_QUEUE
					? row.data.characterId
						? ('arc' as const)
						: row.data.read
							? ('details' as const)
							: ('enrich' as const)
					: ('review' as const),
		data: row.data,
		startedAt: new Date(row.created_on).toISOString()
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
	const characterIds = [
		...new Set(found.flatMap((j) => (j.data.characterId ? [j.data.characterId] : [])))
	];
	const characterNames = new Map(
		characterIds.length
			? (
					await db
						.select({ id: characters.id, name: characters.name })
						.from(characters)
						.where(and(inArray(characters.id, characterIds), eq(characters.ownerId, userId)))
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
			// An arc job is named for its character, within a live universe.
			if (title !== undefined && job.data.characterId) {
				title = characterNames.get(job.data.characterId);
			}
			// A details read is named for its entity, as it was when queued.
			if (title !== undefined && job.data.read) {
				title = typeof job.data.read.name === 'string' ? job.data.read.name : undefined;
			}
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
			title,
			startedAt: job.startedAt
		});
	}
	return out;
}

// Stops one of the writer's unsettled Assistant jobs, so a run that hangs does
// not hold its scope until it expires. Cancelling frees the queue's key at
// once; the worker sees the cancel at its next heartbeat and aborts the run,
// which then reports that it was stopped. False when the job is not this
// writer's, or has already settled.
export async function stopAssistantJob(
	db: Database,
	boss: Pick<PgBoss, 'cancel'>,
	userId: string,
	jobId: string
): Promise<boolean> {
	if (!isUuid(jobId)) return false;
	const { rows } = await db.execute<{ name: string }>(sql`
		select name from pgboss.job
		where id = ${jobId}::uuid
			and name in (
				${ASSISTANT_REVIEW_QUEUE}, ${ASSISTANT_SUMMARIES_QUEUE}, ${ASSISTANT_ENRICH_QUEUE},
				${LEGACY_ASSISTANT_REVIEW_QUEUE}, ${LEGACY_ASSISTANT_SUMMARIES_QUEUE}
			)
			and state in ('created', 'retry', 'active')
			and data @> ${JSON.stringify({ userId })}::jsonb
	`);
	if (rows.length === 0) return false;
	await boss.cancel(rows[0].name, jobId);
	return true;
}
