import { and, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import type { SelectedFields } from 'drizzle-orm/pg-core';
import type { SelectResultFields } from 'drizzle-orm/query-builders/select.types';
import type { Database } from './auth.ts';
import { characters, entityCategories, loreEntries, places, stories } from './db/schema.ts';
import { inLiveUniverse } from './universe-scope.ts';

// The one map from an entity type to its table, and the lookups shared by the
// entity modules, split out so none has to import the others.

export type EntityType = 'character' | 'place' | 'lore_entry';

/** Every entity type, in the order lookups by id try them. */
export const ENTITY_TYPES = [
	'character',
	'place',
	'lore_entry'
] as const satisfies readonly EntityType[];

const ENTITY_TABLES = { character: characters, place: places, lore_entry: loreEntries } as const;

export type EntityTable = (typeof ENTITY_TABLES)[EntityType];

export function entityTable<T extends EntityType>(type: T): (typeof ENTITY_TABLES)[T] {
	return ENTITY_TABLES[type];
}

// A lore entry's title and keywords play the part of a name and aliases.
export function entityNameColumn(table: EntityTable) {
	return 'name' in table ? table.name : table.title;
}

export function entityAliasColumn(table: EntityTable) {
	return 'aliases' in table ? table.aliases : table.keywords;
}

/** The update fields for an entity's name and tags, under lore's column names
 * for a lore entry. Spread into `db.update(entityTable(type)).set(...)`. */
export function entityNaming(
	type: EntityType,
	name: string,
	tags: string[]
): Record<string, unknown> {
	return type === 'lore_entry' ? { title: name, keywords: tags } : { name, aliases: tags };
}

/** A where-clause condition: the row is this user's entity and its universe
 * is not in the trash. */
export function ownedLiveEntity(table: EntityTable, entityId: string, userId: string): SQL {
	return and(eq(table.id, entityId), eq(table.ownerId, userId), inLiveUniverse(table.universeId))!;
}

/** Resolves an entity id to whichever table holds it, owner-scoped and live,
 * selecting `columns(table)`. Null when none of the tables has it for this
 * user. */
export async function resolveOwnedEntity<S extends SelectedFields>(
	db: Database,
	userId: string,
	entityId: string,
	columns: (table: EntityTable) => S
): Promise<({ type: EntityType } & SelectResultFields<S>) | null> {
	for (const type of ENTITY_TYPES) {
		const table = entityTable(type);
		const [row] = await db
			.select(columns(table))
			.from(table)
			.where(ownedLiveEntity(table, entityId, userId));
		if (row) return { type, ...(row as SelectResultFields<S>) };
	}
	return null;
}

export async function namesByType(db: Database, type: EntityType, ids: string[]) {
	if (ids.length === 0) return new Map<string, string>();
	const table = entityTable(type);
	const rows = await db
		.select({ id: table.id, name: entityNameColumn(table) })
		.from(table)
		.where(inArray(table.id, ids));
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
			and(
				eq(stories.id, storyId),
				eq(stories.ownerId, userId),
				eq(stories.universeId, universeId),
				isNull(stories.deletedAt)
			)
		);
	return Boolean(row);
}

export async function entityInUniverse(
	db: Database,
	universeId: string,
	type: EntityType,
	id: string
) {
	const table = entityTable(type);
	const [row] = await db
		.select({ id: table.id })
		.from(table)
		.where(and(eq(table.id, id), eq(table.universeId, universeId)));
	return Boolean(row);
}
