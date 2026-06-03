// Mention index rebuilds. Runs in the worker (plain Node), so relative value
// imports carry explicit .ts extensions.
import { and, eq } from 'drizzle-orm';
import type { Database } from './auth';
import { characters, entityMentions, scenes, stories } from './db/schema.ts';
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
	const targets: MentionTarget[] = cast.map((character) => ({
		id: character.id,
		type: 'character',
		names: [character.name, ...character.aliases]
	}));
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
