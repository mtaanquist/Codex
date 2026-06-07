import { and, asc, count, eq } from 'drizzle-orm';
import type { Database } from './auth';
import {
	characters,
	entityCategories,
	entityMentions,
	loreEntries,
	places,
	scenes,
	stories
} from './db/schema';
import type { EntityKind } from '$lib/components/EntityEditor.svelte';

// Sidebar lists for a Plan view. Both scopes list the whole universe: the
// story Plan does too until declared membership (step 20) narrows it.
export async function planEntityLists(db: Database, universeId: string) {
	const characterList = await db
		.select({ id: characters.id, name: characters.name, color: entityCategories.color })
		.from(characters)
		.leftJoin(entityCategories, eq(characters.categoryId, entityCategories.id))
		.where(eq(characters.universeId, universeId))
		.orderBy(asc(characters.name));
	const placeList = await db
		.select({ id: places.id, name: places.name, color: entityCategories.color })
		.from(places)
		.leftJoin(entityCategories, eq(places.categoryId, entityCategories.id))
		.where(eq(places.universeId, universeId))
		.orderBy(asc(places.name));
	const categories = await db
		.select({
			id: entityCategories.id,
			name: entityCategories.name,
			color: entityCategories.color
		})
		.from(entityCategories)
		.where(eq(entityCategories.universeId, universeId))
		.orderBy(asc(entityCategories.sortOrder), asc(entityCategories.name));
	const loreList = await db
		.select({ id: loreEntries.id, name: loreEntries.title, categoryId: loreEntries.categoryId })
		.from(loreEntries)
		.where(eq(loreEntries.universeId, universeId))
		.orderBy(asc(loreEntries.title));
	return { characters: characterList, places: placeList, categories, lore: loreList };
}

// An entity id arriving from the page URL could be any of the three kinds;
// try them in turn, scoped to the universe so a foreign id resolves to
// nothing. Lore rows expose their title as "name" for the shared editor.
export async function resolvePlanEntity(db: Database, universeId: string, entityId: string) {
	const [characterRow] = await db
		.select()
		.from(characters)
		.where(and(eq(characters.id, entityId), eq(characters.universeId, universeId)));
	if (characterRow) return { kind: 'character' as const, entity: characterRow };
	const [placeRow] = await db
		.select()
		.from(places)
		.where(and(eq(places.id, entityId), eq(places.universeId, universeId)));
	if (placeRow) return { kind: 'place' as const, entity: placeRow };
	const [loreRow] = await db
		.select()
		.from(loreEntries)
		.where(and(eq(loreEntries.id, entityId), eq(loreEntries.universeId, universeId)));
	if (loreRow) return { kind: 'lore' as const, entity: { ...loreRow, name: loreRow.title } };
	return null;
}

export type PlanAppearance = {
	storyId: string;
	storyTitle: string;
	sceneId: string;
	sceneTitle: string | null;
	snippet: string;
	// Character offset of the mention in the scene, for jump links.
	position: number;
};

// Every indexed mention of an entity, for the "Appears in" panel. Scoped to
// one story or to every story in the universe; ordered for display.
export async function entityAppearances(
	db: Database,
	target: { kind: EntityKind; id: string },
	scope: { storyId: string } | { universeId: string }
): Promise<PlanAppearance[]> {
	const targetType = target.kind === 'lore' ? 'lore_entry' : target.kind;
	const scopeFilter =
		'storyId' in scope
			? eq(scenes.storyId, scope.storyId)
			: eq(stories.universeId, scope.universeId);
	return await db
		.select({
			storyId: stories.id,
			storyTitle: stories.title,
			sceneId: scenes.id,
			sceneTitle: scenes.title,
			snippet: entityMentions.surroundingText,
			position: entityMentions.position
		})
		.from(entityMentions)
		.innerJoin(scenes, eq(entityMentions.sourceId, scenes.id))
		.innerJoin(stories, eq(scenes.storyId, stories.id))
		.where(
			and(
				eq(entityMentions.sourceType, 'scene'),
				eq(entityMentions.targetType, targetType),
				eq(entityMentions.targetId, target.id),
				scopeFilter
			)
		)
		.orderBy(
			asc(stories.positionInSeries),
			asc(stories.createdAt),
			asc(scenes.globalPosition),
			asc(entityMentions.position)
		);
}

// Total mentions of an entity across every story in the universe, for the
// "All mentions" summary. A single count, regardless of the page's scope.
export async function entityMentionCount(
	db: Database,
	target: { kind: EntityKind; id: string },
	universeId: string
): Promise<number> {
	const targetType = target.kind === 'lore' ? 'lore_entry' : target.kind;
	const [row] = await db
		.select({ total: count() })
		.from(entityMentions)
		.innerJoin(scenes, eq(entityMentions.sourceId, scenes.id))
		.innerJoin(stories, eq(scenes.storyId, stories.id))
		.where(
			and(
				eq(entityMentions.sourceType, 'scene'),
				eq(entityMentions.targetType, targetType),
				eq(entityMentions.targetId, target.id),
				eq(stories.universeId, universeId)
			)
		);
	return row?.total ?? 0;
}
