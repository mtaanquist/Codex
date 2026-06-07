import { and, eq, sql } from 'drizzle-orm';
import type { Database } from './auth';
import { recordEntityRevision } from './revisions';
import { categoryInUniverse, ownsStoryInUniverse } from './entity-lookups';
import { places, placeStoryNotes } from './db/schema';
import type { EntityDetail } from '$lib/entity-snapshot';

export type PlaceSave = {
	name: string;
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

export async function savePlace(
	db: Database,
	placeId: string,
	userId: string,
	save: PlaceSave
): Promise<
	{ ok: true; universeId: string; mentionsAffected: boolean } | { ok: false; reason: string }
> {
	const [place] = await db
		.select({ id: places.id, universeId: places.universeId, name: places.name })
		.from(places)
		.where(and(eq(places.id, placeId), eq(places.ownerId, userId)));
	if (!place) return { ok: false, reason: 'place not found' };

	const name = save.name.trim();
	if (!name) return { ok: false, reason: 'the place needs a name' };

	// Only a changed name can add or remove mentions.
	const mentionsAffected = name !== place.name;

	if (
		save.categoryId != null &&
		!(await categoryInUniverse(db, save.categoryId, place.universeId))
	) {
		return { ok: false, reason: 'category not found' };
	}

	// Validate the optional story BEFORE anything is written: the old
	// ordering persisted the save, then reported failure and skipped the
	// mention reindex (review finding #191).
	if (
		save.storyId !== undefined &&
		!(await ownsStoryInUniverse(db, save.storyId, userId, place.universeId))
	) {
		return { ok: false, reason: 'story not found' };
	}

	await db
		.update(places)
		.set({
			name,
			summaryMd: save.summaryMd?.trim() || null,
			bodyMd: save.bodyMd,
			...(save.details !== undefined ? { details: save.details } : {}),
			...(save.categoryId !== undefined ? { categoryId: save.categoryId } : {})
		})
		.where(eq(places.id, place.id));
	// Full snapshot, so summary, category, and detail changes register in
	// History even when the body is untouched.
	await recordEntityRevision(db, 'place', place.id);

	if (save.storyId !== undefined) {
		await db
			.insert(placeStoryNotes)
			.values({ placeId: place.id, storyId: save.storyId, notesMd: save.storyNotesMd ?? '' })
			.onConflictDoUpdate({
				target: [placeStoryNotes.placeId, placeStoryNotes.storyId],
				set: { notesMd: save.storyNotesMd ?? '', updatedAt: sql`now()` }
			});
	}
	return { ok: true, universeId: place.universeId, mentionsAffected };
}
