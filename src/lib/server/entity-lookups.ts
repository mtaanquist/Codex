import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from './auth';
import { characters, loreEntries, places } from './db/schema.ts';

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
