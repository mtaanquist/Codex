import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import type { Database } from './auth';
import {
	characters,
	entityCategories,
	entityRelationships,
	loreEntries,
	places,
	relationTypes
} from './db/schema';
import type { EntityKind } from '$lib/components/EntityEditor.svelte';
import { entityInUniverse, namesByType, type EntityType } from './entity-lookups';
import { recordEntityRevision } from './revisions';

export type { EntityType };

export function toEntityType(kind: EntityKind): EntityType {
	return kind === 'lore' ? 'lore_entry' : kind;
}

// The built-in library plus the universe's own types, in picker order.
export async function listRelationTypes(db: Database, universeId: string) {
	return await db
		.select({
			id: relationTypes.id,
			key: relationTypes.key,
			forwardLabel: relationTypes.forwardLabel,
			bidirectional: relationTypes.bidirectional,
			fromType: relationTypes.fromType,
			toType: relationTypes.toType,
			category: relationTypes.category
		})
		.from(relationTypes)
		.where(or(isNull(relationTypes.universeId), eq(relationTypes.universeId, universeId)))
		.orderBy(asc(relationTypes.sortOrder), asc(relationTypes.key));
}

export type RelationshipView = {
	id: string;
	// The label as seen from this entity's side: forward when the entity is
	// the source (or the relation is symmetric), reverse otherwise.
	label: string;
	otherType: EntityType;
	otherId: string;
	otherName: string;
	notesMd: string | null;
};

// Both directions of an entity's universe-wide relationships, display-ready.
export async function listEntityRelationships(
	db: Database,
	universeId: string,
	entity: { kind: EntityKind; id: string }
): Promise<RelationshipView[]> {
	const entityType = toEntityType(entity.kind);
	const rows = await db
		.select({
			id: entityRelationships.id,
			fromType: entityRelationships.fromType,
			fromId: entityRelationships.fromId,
			toType: entityRelationships.toType,
			toId: entityRelationships.toId,
			notesMd: entityRelationships.notesMd,
			forwardLabel: relationTypes.forwardLabel,
			reverseLabel: relationTypes.reverseLabel,
			bidirectional: relationTypes.bidirectional
		})
		.from(entityRelationships)
		.innerJoin(relationTypes, eq(entityRelationships.relationTypeId, relationTypes.id))
		.where(
			and(
				eq(entityRelationships.universeId, universeId),
				// Universe-wide truth only; story-scoped rows are a later step.
				isNull(entityRelationships.storyId),
				or(
					and(
						eq(entityRelationships.fromType, entityType),
						eq(entityRelationships.fromId, entity.id)
					),
					and(eq(entityRelationships.toType, entityType), eq(entityRelationships.toId, entity.id))
				)
			)
		)
		.orderBy(asc(relationTypes.sortOrder), asc(entityRelationships.createdAt));

	const views = rows.map((row) => {
		const isFrom = row.fromType === entityType && row.fromId === entity.id;
		return {
			id: row.id,
			label: isFrom || row.bidirectional ? row.forwardLabel : (row.reverseLabel ?? ''),
			otherType: (isFrom ? row.toType : row.fromType) as EntityType,
			otherId: isFrom ? row.toId : row.fromId,
			otherName: '',
			notesMd: row.notesMd
		};
	});

	for (const type of ['character', 'place', 'lore_entry'] as const) {
		const ids = views.filter((view) => view.otherType === type).map((view) => view.otherId);
		const names = await namesByType(db, type, ids);
		for (const view of views) {
			if (view.otherType === type) view.otherName = names.get(view.otherId) ?? 'Unknown';
		}
	}
	return views;
}

// The editor's hover card shows a few related entities as chips. One pass
// over the universe's relationships builds every entity's list at once,
// with each related entity's name and badge colour (its category's, when
// it has one).
export async function relatedEntitySummaries(
	db: Database,
	universeId: string
): Promise<Map<string, { name: string; color: string | null }[]>> {
	const rows = await db
		.select({
			fromType: entityRelationships.fromType,
			fromId: entityRelationships.fromId,
			toType: entityRelationships.toType,
			toId: entityRelationships.toId
		})
		.from(entityRelationships)
		.where(
			and(
				eq(entityRelationships.universeId, universeId),
				// Universe-wide truth only; story-scoped rows are a later step.
				isNull(entityRelationships.storyId)
			)
		)
		.orderBy(asc(entityRelationships.createdAt));
	if (rows.length === 0) return new Map();

	const idsByType: Record<EntityType, Set<string>> = {
		character: new Set(),
		place: new Set(),
		lore_entry: new Set()
	};
	for (const row of rows) {
		idsByType[row.fromType as EntityType].add(row.fromId);
		idsByType[row.toType as EntityType].add(row.toId);
	}
	const summaries = new Map<string, { name: string; color: string | null }>();
	for (const type of ['character', 'place', 'lore_entry'] as const) {
		const ids = [...idsByType[type]];
		if (ids.length === 0) continue;
		const found =
			type === 'character'
				? await db
						.select({ id: characters.id, name: characters.name, color: entityCategories.color })
						.from(characters)
						.leftJoin(entityCategories, eq(characters.categoryId, entityCategories.id))
						.where(inArray(characters.id, ids))
				: type === 'place'
					? await db
							.select({ id: places.id, name: places.name, color: entityCategories.color })
							.from(places)
							.leftJoin(entityCategories, eq(places.categoryId, entityCategories.id))
							.where(inArray(places.id, ids))
					: await db
							.select({
								id: loreEntries.id,
								name: loreEntries.title,
								color: entityCategories.color
							})
							.from(loreEntries)
							.leftJoin(entityCategories, eq(loreEntries.categoryId, entityCategories.id))
							.where(inArray(loreEntries.id, ids));
		for (const row of found) summaries.set(row.id, { name: row.name, color: row.color });
	}

	const related = new Map<string, { name: string; color: string | null }[]>();
	const seen = new Set<string>();
	const add = (id: string, otherId: string) => {
		// Two relationships between the same pair make one chip.
		if (seen.has(`${id}:${otherId}`)) return;
		seen.add(`${id}:${otherId}`);
		const other = summaries.get(otherId);
		if (!other) return;
		const list = related.get(id) ?? [];
		list.push(other);
		related.set(id, list);
	};
	for (const row of rows) {
		add(row.fromId, row.toId);
		add(row.toId, row.fromId);
	}
	return related;
}

export type RelationshipSave = {
	fromKind: EntityKind;
	fromId: string;
	relationTypeId: string;
	toId: string;
	notesMd?: string;
};

export async function createRelationship(
	db: Database,
	userId: string,
	save: RelationshipSave
): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
	const fromType = toEntityType(save.fromKind);

	// The source entity anchors ownership and the universe.
	const [fromEntity] =
		fromType === 'character'
			? await db
					.select({ universeId: characters.universeId })
					.from(characters)
					.where(and(eq(characters.id, save.fromId), eq(characters.ownerId, userId)))
			: fromType === 'place'
				? await db
						.select({ universeId: places.universeId })
						.from(places)
						.where(and(eq(places.id, save.fromId), eq(places.ownerId, userId)))
				: await db
						.select({ universeId: loreEntries.universeId })
						.from(loreEntries)
						.where(and(eq(loreEntries.id, save.fromId), eq(loreEntries.ownerId, userId)));
	if (!fromEntity) return { ok: false, reason: 'entity not found' };
	const universeId = fromEntity.universeId;

	const [relationType] = await db
		.select()
		.from(relationTypes)
		.where(
			and(
				eq(relationTypes.id, save.relationTypeId),
				or(isNull(relationTypes.universeId), eq(relationTypes.universeId, universeId))
			)
		);
	if (!relationType) return { ok: false, reason: 'relation type not found' };
	if (relationType.fromType !== fromType) {
		return { ok: false, reason: 'that relation does not start from this kind of entity' };
	}
	if (!(await entityInUniverse(db, universeId, relationType.toType, save.toId))) {
		return { ok: false, reason: 'target entity not found' };
	}

	// One row per declared relation; for symmetric relations the swapped
	// order is the same relation.
	const duplicateSides = [
		and(eq(entityRelationships.fromId, save.fromId), eq(entityRelationships.toId, save.toId))
	];
	if (relationType.bidirectional) {
		duplicateSides.push(
			and(eq(entityRelationships.fromId, save.toId), eq(entityRelationships.toId, save.fromId))
		);
	}
	const [duplicate] = await db
		.select({ id: entityRelationships.id })
		.from(entityRelationships)
		.where(
			and(
				eq(entityRelationships.relationTypeId, relationType.id),
				isNull(entityRelationships.storyId),
				or(...duplicateSides)
			)
		);
	if (duplicate) return { ok: false, reason: 'that relationship already exists' };

	const [row] = await db
		.insert(entityRelationships)
		.values({
			universeId,
			ownerId: userId,
			fromType,
			fromId: save.fromId,
			toType: relationType.toType,
			toId: save.toId,
			relationTypeId: relationType.id,
			notesMd: save.notesMd?.trim() || null
		})
		.returning({ id: entityRelationships.id });
	// The relationship set is part of both entities' revision snapshots, so
	// the change lands on both timelines.
	await recordEntityRevision(db, fromType, save.fromId);
	await recordEntityRevision(db, relationType.toType as EntityType, save.toId);
	return { ok: true, id: row.id };
}

export async function deleteRelationship(db: Database, relationshipId: string, userId: string) {
	const [deleted] = await db
		.delete(entityRelationships)
		.where(and(eq(entityRelationships.id, relationshipId), eq(entityRelationships.ownerId, userId)))
		.returning({
			fromType: entityRelationships.fromType,
			fromId: entityRelationships.fromId,
			toType: entityRelationships.toType,
			toId: entityRelationships.toId
		});
	if (!deleted) return false;
	// As with creation, the change registers on both linked timelines.
	await recordEntityRevision(db, deleted.fromType as EntityType, deleted.fromId);
	await recordEntityRevision(db, deleted.toType as EntityType, deleted.toId);
	return true;
}
