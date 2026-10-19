// Per-story mention pins: the author's pick when a name belongs to more
// than one entity. Runs in the worker too (the index rebuild reads them),
// so relative value imports carry explicit .ts extensions.
import { and, eq } from 'drizzle-orm';
import type { Database } from './auth.ts';
import { mentionPins, stories } from './db/schema.ts';
import { entityInUniverse } from './entity-lookups.ts';
import type { EntityType } from './entity-lookups.ts';
import { storyIsLive } from './universe-scope.ts';
import type { ActionFailure } from './action-result.ts';

// The story's pins as detection wants them: matched text -> target id.
export async function listMentionPins(db: Database, storyId: string): Promise<Map<string, string>> {
	const rows = await db
		.select({ name: mentionPins.name, targetId: mentionPins.targetId })
		.from(mentionPins)
		.where(eq(mentionPins.storyId, storyId));
	return new Map(rows.map((row) => [row.name, row.targetId]));
}

export async function setMentionPin(
	db: Database,
	userId: string,
	storyId: string,
	name: string,
	targetType: EntityType,
	targetId: string
): Promise<{ ok: true } | ActionFailure> {
	const trimmed = name.trim();
	if (trimmed.length < 2)
		return { ok: false, code: 'invalid', reason: 'That name is too short to pin.' };
	const [story] = await db
		.select({ id: stories.id, universeId: stories.universeId })
		.from(stories)
		.where(and(eq(stories.id, storyId), eq(stories.ownerId, userId), storyIsLive()));
	if (!story) return { ok: false, code: 'not_found', reason: 'That story does not exist.' };
	if (!(await entityInUniverse(db, story.universeId, targetType, targetId))) {
		return { ok: false, code: 'not_found', reason: 'That entry does not exist.' };
	}
	await db
		.insert(mentionPins)
		.values({ storyId: story.id, name: trimmed, targetType, targetId })
		.onConflictDoUpdate({
			target: [mentionPins.storyId, mentionPins.name],
			set: { targetType, targetId }
		});
	return { ok: true };
}

export async function clearMentionPin(
	db: Database,
	userId: string,
	storyId: string,
	name: string
): Promise<boolean> {
	const [story] = await db
		.select({ id: stories.id })
		.from(stories)
		.where(and(eq(stories.id, storyId), eq(stories.ownerId, userId), storyIsLive()));
	if (!story) return false;
	const deleted = await db
		.delete(mentionPins)
		.where(and(eq(mentionPins.storyId, story.id), eq(mentionPins.name, name.trim())))
		.returning({ id: mentionPins.id });
	return deleted.length > 0;
}
