import type { Database } from './auth';
import { saveEntity, type EntitySaveResult } from './entity-save.ts';
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

// The shared save flow lives in entity-save.ts; this maps the character
// shape (aliases) onto it.
export async function saveCharacter(
	db: Database,
	characterId: string,
	userId: string,
	save: CharacterSave
): Promise<EntitySaveResult> {
	const { aliases, ...rest } = save;
	return await saveEntity(db, 'character', characterId, userId, { ...rest, tags: aliases });
}
