import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from './auth';
import {
	characters,
	characterStoryMemberships,
	entityCategories,
	entityMentions,
	loreEntries,
	placeStoryMemberships,
	places
} from './db/schema';
import { relatedEntitySummaries } from './relationships';
import { listMentionPins } from './mention-pins';
import type { MentionEntity } from '$lib/editor-mentions';

export type ReviewMentionData = {
	entities: MentionEntity[];
	storyMembers: string[];
	pins: Record<string, string>;
};

const EMPTY: ReviewMentionData = { entities: [], storyMembers: [], pins: {} };

// Entities for the review surface's mention highlights and quick cards, in the
// same shape the writing editor uses. For a guest link `restrictToMentioned`
// trims the set to entities that actually appear in the story's scenes, so an
// outside reviewer never receives summaries of entities the manuscript does
// not mention. The author's own review keeps the full set, like the editor.
export async function reviewMentionData(
	db: Database,
	opts: {
		universeId: string;
		storyId: string;
		sceneIds: string[];
		restrictToMentioned: boolean;
	}
): Promise<ReviewMentionData> {
	let allowed: Set<string> | null = null;
	if (opts.restrictToMentioned) {
		if (opts.sceneIds.length === 0) return EMPTY;
		const rows = await db
			.select({ targetId: entityMentions.targetId })
			.from(entityMentions)
			.where(
				and(eq(entityMentions.sourceType, 'scene'), inArray(entityMentions.sourceId, opts.sceneIds))
			);
		allowed = new Set(rows.map((row) => row.targetId));
		if (allowed.size === 0) return EMPTY;
	}
	const keep = (id: string) => allowed === null || allowed.has(id);

	const [
		knownCharacters,
		knownPlaces,
		knownLore,
		relatedByEntity,
		charMembers,
		placeMembers,
		pins
	] = await Promise.all([
		db
			.select({
				id: characters.id,
				name: characters.name,
				aliases: characters.aliases,
				summaryMd: characters.summaryMd,
				details: characters.details,
				color: entityCategories.color,
				categoryName: entityCategories.name,
				badgeColor: characters.badgeColor,
				badgeAssetId: characters.badgeAssetId
			})
			.from(characters)
			.leftJoin(entityCategories, eq(characters.categoryId, entityCategories.id))
			.where(
				and(eq(characters.universeId, opts.universeId), eq(characters.autoDetectMentions, true))
			),
		db
			.select({
				id: places.id,
				name: places.name,
				aliases: places.aliases,
				summaryMd: places.summaryMd,
				details: places.details,
				color: entityCategories.color,
				categoryName: entityCategories.name,
				badgeColor: places.badgeColor,
				badgeAssetId: places.badgeAssetId
			})
			.from(places)
			.leftJoin(entityCategories, eq(places.categoryId, entityCategories.id))
			.where(and(eq(places.universeId, opts.universeId), eq(places.autoDetectMentions, true))),
		db
			.select({
				id: loreEntries.id,
				name: loreEntries.title,
				keywords: loreEntries.keywords,
				summaryMd: loreEntries.summaryMd,
				details: loreEntries.details,
				color: entityCategories.color,
				categoryName: entityCategories.name,
				badgeColor: loreEntries.badgeColor,
				badgeAssetId: loreEntries.badgeAssetId
			})
			.from(loreEntries)
			.leftJoin(entityCategories, eq(loreEntries.categoryId, entityCategories.id))
			.where(
				and(eq(loreEntries.universeId, opts.universeId), eq(loreEntries.autoDetectMentions, true))
			),
		relatedEntitySummaries(db, opts.universeId),
		db
			.select({ id: characterStoryMemberships.characterId })
			.from(characterStoryMemberships)
			.where(eq(characterStoryMemberships.storyId, opts.storyId)),
		db
			.select({ id: placeStoryMemberships.placeId })
			.from(placeStoryMemberships)
			.where(eq(placeStoryMemberships.storyId, opts.storyId)),
		listMentionPins(db, opts.storyId)
	]);

	const entities: MentionEntity[] = [
		...knownCharacters
			.filter((row) => keep(row.id))
			.map((row) => ({
				...row,
				type: 'character' as const,
				related: relatedByEntity.get(row.id) ?? []
			})),
		...knownPlaces
			.filter((row) => keep(row.id))
			.map((row) => ({
				...row,
				type: 'place' as const,
				related: relatedByEntity.get(row.id) ?? []
			})),
		...knownLore
			.filter((row) => keep(row.id))
			.map((row) => ({
				id: row.id,
				type: 'lore_entry' as const,
				name: row.name,
				aliases: row.keywords,
				summaryMd: row.summaryMd,
				details: row.details,
				color: row.color,
				categoryName: row.categoryName,
				badgeColor: row.badgeColor,
				badgeAssetId: row.badgeAssetId,
				related: relatedByEntity.get(row.id) ?? []
			}))
	];

	// A guest only ever sees the quick card, so ship only what it renders (the
	// top few details and related entities) - never the full authored list.
	// The quick card shows 3 details and 4 related; the author keeps the full
	// set, reachable through "Open full details".
	const visible = opts.restrictToMentioned
		? entities.map((entity) => ({
				...entity,
				details: entity.details?.slice(0, 3),
				related: entity.related?.slice(0, 4)
			}))
		: entities;

	const storyMembers = [...charMembers, ...placeMembers].map((row) => row.id).filter(keep);
	const pinObj = Object.fromEntries([...pins].filter(([, id]) => keep(id)));

	return { entities: visible, storyMembers, pins: pinObj };
}
