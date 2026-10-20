import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from './auth.ts';
import {
	characterStoryMemberships,
	entityCategories,
	entityMentions,
	placeStoryMemberships
} from './db/schema.ts';
import {
	entityAliasColumn,
	entityNameColumn,
	entityTable,
	type EntityType
} from './entity-lookups.ts';
import { relatedEntitySummaries } from './relationships.ts';
import { listMentionPins } from './mention-pins.ts';
import type { MentionEntity } from '$lib/editor-mentions';
import { QUICK_CARD_DETAILS, QUICK_CARD_RELATED } from '$lib/quick-card';

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
// not mention. The author's own surfaces keep every entity, like the editor.
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

	const knownEntities = (type: EntityType) => {
		const table = entityTable(type);
		return db
			.select({
				id: table.id,
				name: entityNameColumn(table),
				aliases: entityAliasColumn(table),
				summaryMd: table.summaryMd,
				details: table.details,
				color: entityCategories.color,
				categoryName: entityCategories.name,
				badgeColor: table.badgeColor,
				badgeAssetId: table.badgeAssetId
			})
			.from(table)
			.leftJoin(entityCategories, eq(table.categoryId, entityCategories.id))
			.where(and(eq(table.universeId, opts.universeId), eq(table.autoDetectMentions, true)));
	};

	const [
		knownCharacters,
		knownPlaces,
		knownLore,
		relatedByEntity,
		charMembers,
		placeMembers,
		pins
	] = await Promise.all([
		knownEntities('character'),
		knownEntities('place'),
		knownEntities('lore_entry'),
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

	const asMentions = (type: EntityType, rows: Awaited<ReturnType<typeof knownEntities>>) =>
		rows
			.filter((row) => keep(row.id))
			.map((row) => ({ ...row, type, related: relatedByEntity.get(row.id) ?? [] }));
	const entities: MentionEntity[] = [
		...asMentions('character', knownCharacters),
		...asMentions('place', knownPlaces),
		...asMentions('lore_entry', knownLore)
	];

	// Every consumer renders the quick card only, so ship what it shows (the
	// top few details and related entities), never the full authored list.
	// "Open full details" fetches the whole entity on demand.
	const visible = entities.map((entity) => ({
		...entity,
		details: entity.details?.slice(0, QUICK_CARD_DETAILS),
		related: entity.related?.slice(0, QUICK_CARD_RELATED)
	}));

	const storyMembers = [...charMembers, ...placeMembers].map((row) => row.id).filter(keep);
	const pinObj = Object.fromEntries([...pins].filter(([, id]) => keep(id)));

	return { entities: visible, storyMembers, pins: pinObj };
}
