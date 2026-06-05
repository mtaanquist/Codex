// Mention index rebuilds. Runs in the worker (plain Node), so relative value
// imports carry explicit .ts extensions.
import { and, eq, sql } from 'drizzle-orm';
import type { Database } from './auth';
import { characters, entityMentions, loreEntries, places, scenes, stories } from './db/schema.ts';
import { detectMentions, mentionSnippet, type MentionTarget } from '../mention-detect.ts';

export async function rebuildSceneMentions(
	db: Database,
	sceneId: string
): Promise<{ ok: true; count: number } | { ok: false; reason: string }> {
	const [scene] = await db
		.select({ id: scenes.id, bodyMd: scenes.bodyMd, universeId: stories.universeId })
		.from(scenes)
		.innerJoin(stories, eq(scenes.storyId, stories.id))
		.where(eq(scenes.id, sceneId));
	if (!scene) return { ok: false, reason: 'scene not found' };

	const cast = await db
		.select({ id: characters.id, name: characters.name, aliases: characters.aliases })
		.from(characters)
		.where(
			and(eq(characters.universeId, scene.universeId), eq(characters.autoDetectMentions, true))
		);
	const placeRows = await db
		.select({ id: places.id, name: places.name })
		.from(places)
		.where(and(eq(places.universeId, scene.universeId), eq(places.autoDetectMentions, true)));
	const loreRows = await db
		.select({ id: loreEntries.id, title: loreEntries.title, keywords: loreEntries.keywords })
		.from(loreEntries)
		.where(
			and(eq(loreEntries.universeId, scene.universeId), eq(loreEntries.autoDetectMentions, true))
		);
	const targets: MentionTarget[] = [
		...cast.map(
			(character): MentionTarget => ({
				id: character.id,
				type: 'character',
				names: [character.name, ...character.aliases]
			})
		),
		...placeRows.map(
			(place): MentionTarget => ({ id: place.id, type: 'place', names: [place.name] })
		),
		...loreRows.map(
			(entry): MentionTarget => ({
				id: entry.id,
				type: 'lore_entry',
				names: [entry.title, ...entry.keywords]
			})
		)
	];
	const found = detectMentions(scene.bodyMd, targets);

	await db.transaction(async (tx) => {
		await tx
			.delete(entityMentions)
			.where(and(eq(entityMentions.sourceType, 'scene'), eq(entityMentions.sourceId, scene.id)));
		if (found.length > 0) {
			await tx.insert(entityMentions).values(
				found.map((match) => ({
					sourceType: 'scene',
					sourceId: scene.id,
					targetType: match.targetType,
					targetId: match.targetId,
					position: match.position,
					surroundingText: mentionSnippet(scene.bodyMd, match.position, match.length)
				}))
			);
		}
		// Stamp the watermark in the same transaction. Raw SQL so it does not trip
		// the scene's updated_at $onUpdate, which would make every scene look
		// perpetually stale. now() marks "indexed as of this instant"; a later
		// body or entity change moves past it and the reconcile sweep catches it.
		await tx.execute(sql`update scenes set mentions_indexed_at = now() where id = ${scene.id}`);
	});
	return { ok: true, count: found.length };
}

// After a character's name or aliases change, every scene in the universe may
// gain or lose mentions.
export async function rebuildUniverseMentions(db: Database, universeId: string): Promise<number> {
	const sceneRows = await db
		.select({ id: scenes.id })
		.from(scenes)
		.innerJoin(stories, eq(scenes.storyId, stories.id))
		.where(eq(stories.universeId, universeId));
	for (const row of sceneRows) {
		await rebuildSceneMentions(db, row.id);
	}
	return sceneRows.length;
}

// Scenes whose mention index is behind: never indexed, or indexed before the
// scene's body last changed, or before any character/place/lore in its universe
// last changed (an alias edit that should add or drop mentions). This is the
// backstop for a dropped rebuild job, which would otherwise leave the index
// stale until the next manual save. Ordered oldest-first so the longest-stale
// scenes are caught first; bounded so one sweep cannot run unbounded.
export async function listStaleMentionScenes(db: Database, limit = 200): Promise<string[]> {
	const result = await db.execute(sql`
		select s.id
		from scenes s
		join stories st on st.id = s.story_id
		where s.mentions_indexed_at is null
			or s.mentions_indexed_at < s.updated_at
			or s.mentions_indexed_at < greatest(
				coalesce((select max(updated_at) from characters where universe_id = st.universe_id), to_timestamp(0)),
				coalesce((select max(updated_at) from places where universe_id = st.universe_id), to_timestamp(0)),
				coalesce((select max(updated_at) from lore_entries where universe_id = st.universe_id), to_timestamp(0))
			)
		order by s.mentions_indexed_at asc nulls first
		limit ${limit}
	`);
	return result.rows.map((row) => (row as { id: string }).id);
}

// Re-indexes every stale scene found in one bounded pass. Returns how many were
// rebuilt, so the worker can log a non-empty sweep. Idempotent: a scene already
// in step with its content is left alone.
export async function reconcileMentions(db: Database, limit = 200): Promise<number> {
	const ids = await listStaleMentionScenes(db, limit);
	for (const id of ids) {
		await rebuildSceneMentions(db, id);
	}
	return ids.length;
}
