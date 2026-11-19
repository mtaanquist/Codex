import { sql } from 'drizzle-orm';
import type { Database } from './auth.ts';

// Write paths that lock rows of more than one kind take them in one order, so
// two of them never each hold a row the other needs: a story's scenes, then
// the story, then entities (characters, places, lore), then its chapters,
// each kind lowest id first. A plain UPDATE locks its rows in whatever order
// its plan meets them, so lock first when a statement touches several rows.
// Rows that are only updated, not deleted, are locked for no key update: that
// still lets a foreign-key check (key share) through, so inserting or moving a
// scene into a chapter does not wait on a renumber.
// tests/integration/lock-order.test.ts checks the write paths against this.

/** Locks every scene row of the story, trashed ones too, then the story row,
 * which a story with no scenes yet still has. Adding, moving or renumbering
 * scenes holds the whole story, so two such changes take turns. The advisory
 * lock comes first so a caller that waited sees, and locks, a scene the one
 * before it added: a row inserted after the scene select started is not
 * locked by it, and a mention rebuild holding that row while it waits for the
 * story would deadlock. */
export async function lockStoryScenes(tx: Database, storyId: string): Promise<void> {
	await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`story-scenes:${storyId}`}))`);
	await tx.execute(sql`select id from scenes where story_id = ${storyId} order by id for update`);
	await tx.execute(sql`select id from stories where id = ${storyId} for no key update`);
}

/** Locks every chapter row of the story, before renumbering them. */
export async function lockStoryChapters(tx: Database, storyId: string): Promise<void> {
	await tx.execute(
		sql`select id from chapters where story_id = ${storyId} order by id for no key update`
	);
}
