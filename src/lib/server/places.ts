import { and, eq, sql } from 'drizzle-orm';
import type { Database } from './auth';
import { recordEntityRevision } from './revisions';
import { entityCategories, places, placeStoryNotes, stories } from './db/schema';
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

	if (save.categoryId != null) {
		const [category] = await db
			.select({ id: entityCategories.id })
			.from(entityCategories)
			.where(
				and(
					eq(entityCategories.id, save.categoryId),
					eq(entityCategories.universeId, place.universeId)
				)
			);
		if (!category) return { ok: false, reason: 'category not found' };
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
		const [story] = await db
			.select({ id: stories.id })
			.from(stories)
			.where(and(eq(stories.id, save.storyId), eq(stories.ownerId, userId)));
		if (!story) return { ok: false, reason: 'story not found' };
		await db
			.insert(placeStoryNotes)
			.values({ placeId: place.id, storyId: story.id, notesMd: save.storyNotesMd ?? '' })
			.onConflictDoUpdate({
				target: [placeStoryNotes.placeId, placeStoryNotes.storyId],
				set: { notesMd: save.storyNotesMd ?? '', updatedAt: sql`now()` }
			});
	}
	return { ok: true, universeId: place.universeId, mentionsAffected };
}
