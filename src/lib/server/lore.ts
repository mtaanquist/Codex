import type { Database } from './auth';
import { saveEntity, type EntitySaveResult } from './entity-save.ts';
import type { EntityDetail } from '$lib/entity-snapshot';

export type LoreSave = {
	// The entry's title; arrives as "name" from the shared entity editor.
	name: string;
	keywords: string[];
	summaryMd: string | null;
	bodyMd: string;
	// Quick details; undefined leaves them unchanged.
	details?: EntityDetail[];
	// A lore entry always has a category (NOT NULL in the schema), so unlike
	// characters and places there is no null-to-clear option here.
	categoryId?: string;
	// When present, the per-story "In this book" notes are upserted too.
	storyId?: string;
	storyNotesMd?: string;
};

// The shared save flow lives in entity-save.ts; this maps the lore shape
// (keywords) onto it.
export async function saveLoreEntry(
	db: Database,
	loreEntryId: string,
	userId: string,
	save: LoreSave
): Promise<EntitySaveResult> {
	const { keywords, ...rest } = save;
	return await saveEntity(db, 'lore', loreEntryId, userId, { ...rest, tags: keywords });
}
