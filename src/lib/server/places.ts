import type { Database } from './auth';
import { saveEntity, type EntitySaveResult } from './entity-save.ts';
import type { EntityDetail } from '$lib/entity-snapshot';

export type PlaceSave = {
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

// The shared save flow lives in entity-save.ts; this maps the place shape
// (aliases) onto it.
export async function savePlace(
	db: Database,
	placeId: string,
	userId: string,
	save: PlaceSave
): Promise<EntitySaveResult> {
	const { aliases, ...rest } = save;
	return await saveEntity(db, 'place', placeId, userId, { ...rest, tags: aliases });
}
