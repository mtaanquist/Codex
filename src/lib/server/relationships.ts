import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import type { Database } from './auth';
import { characters, entityRelationships, loreEntries, places, relationTypes } from './db/schema';
import type { EntityKind } from '$lib/components/EntityEditor.svelte';

export type EntityType = 'character' | 'place' | 'lore_entry';

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

async function namesByType(db: Database, type: EntityType, ids: string[]) {
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

async function entityInUniverse(db: Database, universeId: string, type: EntityType, id: string) {
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
	return { ok: true, id: row.id };
}

export async function deleteRelationship(db: Database, relationshipId: string, userId: string) {
	const deleted = await db
		.delete(entityRelationships)
		.where(and(eq(entityRelationships.id, relationshipId), eq(entityRelationships.ownerId, userId)))
		.returning({ id: entityRelationships.id });
	return deleted.length > 0;
}
