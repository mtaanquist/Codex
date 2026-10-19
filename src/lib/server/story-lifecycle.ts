// Story trash. Deleting a story is a soft delete: it leaves every live read at
// once but sits restorable for the same window as a trashed universe, after
// which the worker purges it for good. The slug stays reserved meanwhile, so a
// restore never clashes. Runs in the worker, so relative value imports carry
// explicit .ts extensions.
import { and, eq, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import type { Database } from './auth.ts';
import { stories, universes } from './db/schema.ts';
import { purgeStory } from './story-delete.ts';
import { UNIVERSE_TRASH_DAYS } from './universe-lifecycle.ts';

export const STORY_TRASH_DAYS = UNIVERSE_TRASH_DAYS;

// The story if the user owns it, its universe is live, and it is live or, with
// deleted: true, in the trash.
async function ownedStoryRow(
	db: Database,
	userId: string,
	storyId: string,
	options: { deleted?: boolean } = {}
): Promise<{ id: string } | null> {
	const [row] = await db
		.select({ id: stories.id })
		.from(stories)
		.innerJoin(universes, eq(stories.universeId, universes.id))
		.where(
			and(
				eq(stories.id, storyId),
				eq(stories.ownerId, userId),
				isNull(universes.deletedAt),
				options.deleted ? isNotNull(stories.deletedAt) : isNull(stories.deletedAt)
			)
		);
	return row ?? null;
}

/** Moves a story to the trash. Nothing inside is touched. */
export async function trashStory(db: Database, userId: string, storyId: string): Promise<boolean> {
	const story = await ownedStoryRow(db, userId, storyId);
	if (!story) return false;
	await db
		.update(stories)
		.set({ deletedAt: sql`now()` })
		.where(eq(stories.id, story.id));
	return true;
}

/** Brings a trashed story back whole. */
export async function restoreStory(
	db: Database,
	userId: string,
	storyId: string
): Promise<boolean> {
	const story = await ownedStoryRow(db, userId, storyId, { deleted: true });
	if (!story) return false;
	await db.update(stories).set({ deletedAt: null }).where(eq(stories.id, story.id));
	return true;
}

export type TrashedStory = {
	id: string;
	title: string;
	universeName: string;
	deletedAt: Date;
	daysLeft: number;
};

/** The dashboard's deleted-stories block, newest deletion first. A story in a
 * trashed universe shows under its universe instead. */
export async function listTrashedStories(db: Database, userId: string): Promise<TrashedStory[]> {
	const rows = await db
		.select({
			id: stories.id,
			title: stories.title,
			universeName: universes.name,
			deletedAt: stories.deletedAt
		})
		.from(stories)
		.innerJoin(universes, eq(stories.universeId, universes.id))
		.where(
			and(eq(stories.ownerId, userId), isNotNull(stories.deletedAt), isNull(universes.deletedAt))
		)
		.orderBy(sql`${stories.deletedAt} desc`);
	return rows.map((row) => {
		const deletedAt = row.deletedAt as Date;
		const elapsed = Date.now() - deletedAt.getTime();
		const daysLeft = Math.max(0, STORY_TRASH_DAYS - Math.floor(elapsed / 86_400_000));
		return { id: row.id, title: row.title, universeName: row.universeName, deletedAt, daysLeft };
	});
}

/** Deletes a trashed story for good, right now. Owner-guarded. */
export async function destroyStory(
	db: Database,
	userId: string,
	storyId: string
): Promise<boolean> {
	const story = await ownedStoryRow(db, userId, storyId, { deleted: true });
	if (!story) return false;
	await purgeStory(db, story.id);
	return true;
}

/** Stories whose trash window has elapsed and are due for the purge. */
export async function listStoriesDueForPurge(db: Database): Promise<string[]> {
	const rows = await db
		.select({ id: stories.id })
		.from(stories)
		.where(
			and(
				isNotNull(stories.deletedAt),
				lte(stories.deletedAt, sql`now() - make_interval(days => ${STORY_TRASH_DAYS})`)
			)
		);
	return rows.map((row) => row.id);
}
