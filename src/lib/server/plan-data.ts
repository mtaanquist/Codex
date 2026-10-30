import type { EntityCardData } from '#lib/wire-types';
import { and, asc, count, eq, isNull } from 'drizzle-orm';
import type { Database } from './auth.ts';
import {
	characters,
	entityCategories,
	entityMentions,
	loreEntries,
	places,
	scenes,
	stories
} from './db/schema.ts';
import type { EntityKind } from '#lib/components/EntityEditor.svelte';
import { listEntityRelationships } from './relationships.ts';
import {
	entityAliasColumn,
	entityNameColumn,
	entityTable,
	resolveOwnedEntity,
	type EntityTable
} from './entity-lookups.ts';

// Sidebar lists for a Plan view. Both scopes list the whole universe: the
// story Plan does too until declared membership (step 20) narrows it.
export async function planEntityLists(db: Database, universeId: string) {
	const memberList = (type: 'character' | 'place') => {
		const table = entityTable(type);
		return db
			.select({
				id: table.id,
				name: table.name,
				color: entityCategories.color,
				badgeColor: table.badgeColor,
				badgeAssetId: table.badgeAssetId
			})
			.from(table)
			.leftJoin(entityCategories, eq(table.categoryId, entityCategories.id))
			.where(eq(table.universeId, universeId))
			.orderBy(asc(table.name));
	};
	const characterList = await memberList('character');
	const placeList = await memberList('place');
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
		.select({
			id: loreEntries.id,
			name: loreEntries.title,
			categoryId: loreEntries.categoryId,
			badgeColor: loreEntries.badgeColor,
			badgeAssetId: loreEntries.badgeAssetId
		})
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
				isNull(stories.deletedAt),
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
				eq(stories.universeId, universeId),
				isNull(stories.deletedAt)
			)
		);
	return row?.total ?? 0;
}

export type { EntityCardData } from '#lib/wire-types';

// An entity by id with its category, details, and typed relationships, for
// the editor's read-only entity card. Owner-scoped, so a foreign id resolves
// to nothing.
const cardColumns = (table: EntityTable) => ({
	universeId: table.universeId,
	name: entityNameColumn(table),
	aliases: entityAliasColumn(table),
	summaryMd: table.summaryMd,
	bodyMd: table.bodyMd,
	details: table.details,
	categoryId: table.categoryId,
	badgeColor: table.badgeColor,
	badgeAssetId: table.badgeAssetId
});

export async function getEntityCard(
	db: Database,
	userId: string,
	entityId: string
): Promise<EntityCardData | null> {
	const base = await resolveOwnedEntity(db, userId, entityId, cardColumns);
	if (!base) return null;
	const kind = base.type === 'lore_entry' ? ('lore' as const) : base.type;
	const [category] = base.categoryId
		? await db
				.select({ name: entityCategories.name, color: entityCategories.color })
				.from(entityCategories)
				.where(eq(entityCategories.id, base.categoryId))
		: [];
	const relationships = await listEntityRelationships(db, base.universeId, {
		kind,
		id: entityId
	});
	return {
		id: entityId,
		kind,
		name: base.name,
		categoryName: category?.name ?? null,
		categoryColor: category?.color ?? null,
		badgeColor: base.badgeColor,
		badgeAssetId: base.badgeAssetId,
		aliases: base.aliases ?? [],
		summaryMd: base.summaryMd,
		bodyMd: base.bodyMd,
		details: base.details ?? [],
		related: relationships.map((relationship) => ({
			id: relationship.otherId,
			name: relationship.otherName,
			kind: relationship.otherType === 'lore_entry' ? ('lore' as const) : relationship.otherType,
			label: relationship.label
		}))
	};
}
