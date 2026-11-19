import { sql } from 'drizzle-orm';
import type { Database } from './auth.ts';

// Write paths that lock rows of more than one kind take them in one order, so
// two of them never each hold a row the other needs: a story's scenes, then
// the story, then its chapters, then entities (characters, places, lore),
// each kind lowest id first. A plain UPDATE locks its rows in whatever order
// its plan meets them, so lock first when a statement touches several rows.
// Rows that are only updated, not deleted, are locked for no key update: that
// still lets a foreign-key check (key share) through, so inserting or moving a
// scene into a chapter does not wait on a renumber.
// tests/integration/lock-order.test.ts checks the write paths against this.

/** Locks every scene row of the story, trashed ones too. Adding, moving or
 * renumbering scenes holds the whole story, so two such changes take turns. */
export async function lockStoryScenes(tx: Database, storyId: string): Promise<void> {
	await tx.execute(sql`select id from scenes where story_id = ${storyId} order by id for update`);
}

/** Locks every chapter row of the story, before renumbering them. */
export async function lockStoryChapters(tx: Database, storyId: string): Promise<void> {
	await tx.execute(
		sql`select id from chapters where story_id = ${storyId} order by id for no key update`
	);
}
