import { and, eq, sql } from 'drizzle-orm';
import type { Database } from './auth';
import { characters, characterStoryNotes, stories } from './db/schema';

export type CharacterSave = {
	name: string;
	aliases: string[];
	summaryMd: string | null;
	bodyMd: string;
	// When present, the per-story "In this book" notes are upserted too.
	storyId?: string;
	storyNotesMd?: string;
};

export async function saveCharacter(
	db: Database,
	characterId: string,
	userId: string,
	save: CharacterSave
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const [character] = await db
		.select({ id: characters.id })
		.from(characters)
		.where(and(eq(characters.id, characterId), eq(characters.ownerId, userId)));
	if (!character) return { ok: false, reason: 'character not found' };

	const name = save.name.trim();
	if (!name) return { ok: false, reason: 'the character needs a name' };
	const aliases = save.aliases.map((alias) => alias.trim()).filter((alias) => alias !== '');

	await db
		.update(characters)
		.set({
			name,
			aliases,
			summaryMd: save.summaryMd?.trim() || null,
			bodyMd: save.bodyMd
		})
		.where(eq(characters.id, character.id));

	if (save.storyId !== undefined) {
		const [story] = await db
			.select({ id: stories.id })
			.from(stories)
			.where(and(eq(stories.id, save.storyId), eq(stories.ownerId, userId)));
		if (!story) return { ok: false, reason: 'story not found' };
		await db
			.insert(characterStoryNotes)
			.values({ characterId: character.id, storyId: story.id, notesMd: save.storyNotesMd ?? '' })
			.onConflictDoUpdate({
				target: [characterStoryNotes.characterId, characterStoryNotes.storyId],
				set: { notesMd: save.storyNotesMd ?? '', updatedAt: sql`now()` }
			});
	}
	return { ok: true };
}
