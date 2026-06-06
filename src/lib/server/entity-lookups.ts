import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from './auth';
import { characters, entityCategories, loreEntries, places, stories } from './db/schema.ts';

// Lookups shared by the relationship, revision, and mention-pin modules,
// split out so none has to import the others. The mention-pin path runs in
// the worker, so the value import above carries its explicit .ts extension.

export type EntityType = 'character' | 'place' | 'lore_entry';

export async function namesByType(db: Database, type: EntityType, ids: string[]) {
	if (ids.length === 0) return new Map<string, string>();
	const rows =
		type === 'character'
			? await db
					.select({ id: characters.id, name: characters.name })
					.from(characters)
					.where(inArray(characters.id, ids))
			: type === 'place'
				? await db
						.select({ id: places.id, name: places.name })
						.from(places)
						.where(inArray(places.id, ids))
				: await db
						.select({ id: loreEntries.id, name: loreEntries.title })
						.from(loreEntries)
						.where(inArray(loreEntries.id, ids));
	return new Map(rows.map((row) => [row.id, row.name]));
}

// Shared guards for the entity-save path: a category and a story-note target
// must both belong to the entity's universe (and the story to the saver), so a
// note cannot borrow a category or wire a note across universes.
export async function categoryInUniverse(
	db: Database,
	categoryId: string,
	universeId: string
): Promise<boolean> {
	const [row] = await db
		.select({ id: entityCategories.id })
		.from(entityCategories)
		.where(and(eq(entityCategories.id, categoryId), eq(entityCategories.universeId, universeId)));
	return Boolean(row);
}

export async function ownsStoryInUniverse(
	db: Database,
	storyId: string,
	userId: string,
	universeId: string
): Promise<boolean> {
	const [row] = await db
		.select({ id: stories.id })
		.from(stories)
		.where(
			and(eq(stories.id, storyId), eq(stories.ownerId, userId), eq(stories.universeId, universeId))
		);
	return Boolean(row);
}

export async function entityInUniverse(
	db: Database,
	universeId: string,
	type: EntityType,
	id: string
) {
	if (type === 'character') {
		const [row] = await db
			.select({ id: characters.id })
			.from(characters)
			.where(and(eq(characters.id, id), eq(characters.universeId, universeId)));
		return Boolean(row);
	}
	if (type === 'place') {
		const [row] = await db
			.select({ id: places.id })
			.from(places)
			.where(and(eq(places.id, id), eq(places.universeId, universeId)));
		return Boolean(row);
	}
	const [row] = await db
		.select({ id: loreEntries.id })
		.from(loreEntries)
		.where(and(eq(loreEntries.id, id), eq(loreEntries.universeId, universeId)));
	return Boolean(row);
}
