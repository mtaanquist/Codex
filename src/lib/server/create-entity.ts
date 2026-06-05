import { asc, eq } from 'drizzle-orm';
import type { Database } from './auth';
import {
	characters,
	characterStoryMemberships,
	entityCategories,
	loreEntries,
	places,
	placeStoryMemberships
} from './db/schema';
import type { EntityType } from './entity-lookups';

export const ENTITY_NAME_MAX = 120;

type Scope = { universeId: string; ownerId: string; storyId: string };

/**
 * Creates an entity by name alone, for the editor's create-from-selection
 * popover. Mirrors the Plan sidebar's create actions: a character or place
 * created while working in a story is declared a member of it; a lore entry
 * files under the universe's first category. The caller owns the access
 * check on the scope.
 */
export async function createStoryEntity(
	db: Database,
	scope: Scope,
	type: EntityType,
	rawName: string
): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
	const name = rawName.replace(/\s+/g, ' ').trim();
	if (!name) return { ok: false, reason: 'The selection is empty.' };
	if (name.length > ENTITY_NAME_MAX) {
		return { ok: false, reason: 'That selection is too long for a name.' };
	}
	if (type === 'character') {
		const [character] = await db
			.insert(characters)
			.values({ universeId: scope.universeId, ownerId: scope.ownerId, name })
			.returning({ id: characters.id });
		await db
			.insert(characterStoryMemberships)
			.values({ characterId: character.id, storyId: scope.storyId });
		return { ok: true, id: character.id };
	}
	if (type === 'place') {
		const [place] = await db
			.insert(places)
			.values({ universeId: scope.universeId, ownerId: scope.ownerId, name })
			.returning({ id: places.id });
		await db.insert(placeStoryMemberships).values({ placeId: place.id, storyId: scope.storyId });
		return { ok: true, id: place.id };
	}
	const [category] = await db
		.select({ id: entityCategories.id })
		.from(entityCategories)
		.where(eq(entityCategories.universeId, scope.universeId))
		.orderBy(asc(entityCategories.sortOrder))
		.limit(1);
	if (!category) return { ok: false, reason: 'The universe has no lore category yet.' };
	const [entry] = await db
		.insert(loreEntries)
		.values({
			universeId: scope.universeId,
			ownerId: scope.ownerId,
			categoryId: category.id,
			title: name
		})
		.returning({ id: loreEntries.id });
	return { ok: true, id: entry.id };
}
