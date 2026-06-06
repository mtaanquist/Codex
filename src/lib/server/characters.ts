import { and, eq, sql } from 'drizzle-orm';
import type { Database } from './auth';
import { recordEntityRevision } from './revisions';
import { characters, characterStoryNotes, entityCategories, stories } from './db/schema';
import type { EntityDetail } from '$lib/entity-snapshot';

export type CharacterSave = {
	name: string;
	aliases: string[];
	summaryMd: string | null;
	bodyMd: string;
	// Quick details; undefined leaves them unchanged.
	details?: EntityDetail[];
	// Optional grouping; null clears it, undefined leaves it unchanged.
	categoryId?: string | null;
	// When present, the per-story "In this book" notes are upserted too.
	storyId?: string;
	storyNotesMd?: string;
};

export async function saveCharacter(
	db: Database,
	characterId: string,
	userId: string,
	save: CharacterSave
): Promise<
	{ ok: true; universeId: string; mentionsAffected: boolean } | { ok: false; reason: string }
> {
	const [character] = await db
		.select({
			id: characters.id,
			universeId: characters.universeId,
			name: characters.name,
			aliases: characters.aliases
		})
		.from(characters)
		.where(and(eq(characters.id, characterId), eq(characters.ownerId, userId)));
	if (!character) return { ok: false, reason: 'character not found' };

	const name = save.name.trim();
	if (!name) return { ok: false, reason: 'the character needs a name' };
	const aliases = save.aliases.map((alias) => alias.trim()).filter((alias) => alias !== '');

	// Only a changed name or alias set can add or remove mentions; body and
	// summary edits should not trigger a universe-wide reindex.
	const mentionsAffected =
		name !== character.name ||
		aliases.length !== character.aliases.length ||
		aliases.some((alias, index) => alias !== character.aliases[index]);

	if (save.categoryId != null) {
		const [category] = await db
			.select({ id: entityCategories.id })
			.from(entityCategories)
			.where(
				and(
					eq(entityCategories.id, save.categoryId),
					eq(entityCategories.universeId, character.universeId)
				)
			);
		if (!category) return { ok: false, reason: 'category not found' };
	}

	// Validate the optional story BEFORE anything is written: the old
	// ordering persisted the save, then reported failure and skipped the
	// mention reindex (review finding #191).
	if (save.storyId !== undefined) {
		const [story] = await db
			.select({ id: stories.id })
			.from(stories)
			.where(and(eq(stories.id, save.storyId), eq(stories.ownerId, userId)));
		if (!story) return { ok: false, reason: 'story not found' };
	}

	await db
		.update(characters)
		.set({
			name,
			aliases,
			summaryMd: save.summaryMd?.trim() || null,
			bodyMd: save.bodyMd,
			...(save.details !== undefined ? { details: save.details } : {}),
			...(save.categoryId !== undefined ? { categoryId: save.categoryId } : {})
		})
		.where(eq(characters.id, character.id));
	// Full snapshot, so alias, summary, category, and detail changes register
	// in History even when the body is untouched.
	await recordEntityRevision(db, 'character', character.id);

	if (save.storyId !== undefined) {
		await db
			.insert(characterStoryNotes)
			.values({
				characterId: character.id,
				storyId: save.storyId,
				notesMd: save.storyNotesMd ?? ''
			})
			.onConflictDoUpdate({
				target: [characterStoryNotes.characterId, characterStoryNotes.storyId],
				set: { notesMd: save.storyNotesMd ?? '', updatedAt: sql`now()` }
			});
	}
	return { ok: true, universeId: character.universeId, mentionsAffected };
}
