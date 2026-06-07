import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from './auth';
import { isCategoryColor } from '$lib/entity-color';
import { entityCategories } from './db/schema';

// The universe settings' category manager: list with usage counts, and one
// save that applies the whole edited list (renames, colours, order, adds,
// and deletes) in a single transaction.

export type CategoryRow = {
	id: string;
	name: string;
	color: string | null;
	entries: number;
};

export async function listCategories(db: Database, universeId: string): Promise<CategoryRow[]> {
	const result = await db.execute(sql`
		select c.id, c.name, c.color,
			(select count(*) from lore_entries l where l.category_id = c.id)::int
			+ (select count(*) from characters ch where ch.category_id = c.id)::int
			+ (select count(*) from places p where p.category_id = c.id)::int as entries
		from entity_categories c
		where c.universe_id = ${universeId}
		order by c.sort_order asc, c.created_at asc
	`);
	return result.rows as CategoryRow[];
}

export type CategorySave = {
	// Null for a newly added category.
	id: string | null;
	name: string;
	color: string | null;
};

export const CATEGORY_NAME_MAX = 60;

/**
 * Applies the edited category list: rows arrive in display order; existing
 * categories missing from the list are deleted. Returns a user-facing
 * reason on rejection.
 */
export async function saveCategories(
	db: Database,
	owner: { universeId: string; ownerId: string },
	rows: CategorySave[]
): Promise<{ ok: true } | { ok: false; reason: string }> {
	if (rows.length === 0) {
		return { ok: false, reason: 'Keep at least one category; lore entries need a home.' };
	}
	for (const row of rows) {
		const name = row.name.trim();
		if (!name) return { ok: false, reason: 'Every category needs a name.' };
		if (name.length > CATEGORY_NAME_MAX) {
			return { ok: false, reason: 'Category names can be at most 60 characters.' };
		}
		if (!isCategoryColor(row.color)) {
			return { ok: false, reason: 'Pick a colour from the list.' };
		}
	}

	const existing = await listCategories(db, owner.universeId);
	const existingIds = new Set(existing.map((category) => category.id));
	const keptIds = new Set(rows.filter((row) => row.id).map((row) => row.id as string));
	for (const id of keptIds) {
		if (!existingIds.has(id)) return { ok: false, reason: 'That category does not exist.' };
	}
	const removed = existing.filter((category) => !keptIds.has(category.id));
	for (const category of removed) {
		if (category.entries > 0) {
			return {
				ok: false,
				reason: `"${category.name}" still has entries; move or delete them first.`
			};
		}
	}

	await db.transaction(async (tx) => {
		if (removed.length > 0) {
			await tx.delete(entityCategories).where(
				inArray(
					entityCategories.id,
					removed.map((category) => category.id)
				)
			);
		}
		for (const [index, row] of rows.entries()) {
			const values = { name: row.name.trim(), color: row.color, sortOrder: index };
			if (row.id) {
				await tx
					.update(entityCategories)
					.set(values)
					.where(
						and(eq(entityCategories.id, row.id), eq(entityCategories.universeId, owner.universeId))
					);
			} else {
				await tx.insert(entityCategories).values({
					...values,
					universeId: owner.universeId,
					ownerId: owner.ownerId
				});
			}
		}
	});
	return { ok: true };
}

/** The Contents card's tiles: what the universe holds right now. */
export async function universeContents(
	db: Database,
	universeId: string
): Promise<{ stories: number; characters: number; places: number; lore: number; words: number }> {
	const result = await db.execute(sql`
		select
			(select count(*) from stories st where st.universe_id = ${universeId})::int as stories,
			(select count(*) from characters c where c.universe_id = ${universeId})::int as characters,
			(select count(*) from places p where p.universe_id = ${universeId})::int as places,
			(select count(*) from lore_entries l where l.universe_id = ${universeId})::int as lore,
			coalesce((
				select sum(s.word_count) from scenes s
				join stories st on st.id = s.story_id
				where st.universe_id = ${universeId} and s.deleted_at is null
			), 0)::int as words
	`);
	return result.rows[0] as {
		stories: number;
		characters: number;
		places: number;
		lore: number;
		words: number;
	};
}
