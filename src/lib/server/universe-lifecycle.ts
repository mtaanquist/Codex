// Universe trash and the purge cascade. Deleting a universe is a soft
// delete: it leaves every live read at once but sits restorable for the
// window below, after which the worker purges it for good. The cascade is
// shared with the account purge. Runs in the worker, so relative value
// imports carry explicit .ts extensions.
import { and, eq, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import type { Database } from './auth';
import {
	assets,
	characters,
	entityCategories,
	entityRelationships,
	loreEntries,
	places,
	relationTypes,
	revisions,
	stories,
	universes
} from './db/schema.ts';
import { deleteStoryWithin, type Tx } from './story-delete.ts';

export const UNIVERSE_TRASH_DAYS = 30;

async function ownedUniverseRow(
	db: Database,
	userId: string,
	universeId: string,
	deleted: boolean
) {
	const [row] = await db
		.select({ id: universes.id })
		.from(universes)
		.where(
			and(
				eq(universes.id, universeId),
				eq(universes.ownerId, userId),
				deleted ? isNotNull(universes.deletedAt) : isNull(universes.deletedAt)
			)
		);
	return row ?? null;
}

/** Moves a universe to the trash. Everything inside stops resolving at
 * once; published editions stay frozen until the purge. */
export async function trashUniverse(
	db: Database,
	userId: string,
	universeId: string
): Promise<boolean> {
	const universe = await ownedUniverseRow(db, userId, universeId, false);
	if (!universe) return false;
	await db
		.update(universes)
		.set({ deletedAt: sql`now()` })
		.where(eq(universes.id, universe.id));
	return true;
}

/** Brings a trashed universe back whole; nothing inside was touched. */
export async function restoreUniverse(
	db: Database,
	userId: string,
	universeId: string
): Promise<boolean> {
	const universe = await ownedUniverseRow(db, userId, universeId, true);
	if (!universe) return false;
	await db.update(universes).set({ deletedAt: null }).where(eq(universes.id, universe.id));
	return true;
}

export type TrashedUniverse = {
	id: string;
	name: string;
	deletedAt: Date;
	daysLeft: number;
};

/** The dashboard's deleted-universes block, newest deletion first. */
export async function listTrashedUniverses(
	db: Database,
	userId: string
): Promise<TrashedUniverse[]> {
	const rows = await db
		.select({ id: universes.id, name: universes.name, deletedAt: universes.deletedAt })
		.from(universes)
		.where(and(eq(universes.ownerId, userId), isNotNull(universes.deletedAt)))
		.orderBy(sql`${universes.deletedAt} desc`);
	return rows.map((row) => {
		const deletedAt = row.deletedAt as Date;
		const elapsed = Date.now() - deletedAt.getTime();
		const daysLeft = Math.max(0, UNIVERSE_TRASH_DAYS - Math.floor(elapsed / 86_400_000));
		return { id: row.id, name: row.name, deletedAt, daysLeft };
	});
}

/** Deletes a trashed universe for good, right now. Owner-guarded; the
 * uploaded image objects are swept by the caller via the returned keys. */
export async function destroyUniverse(
	db: Database,
	userId: string,
	universeId: string
): Promise<{ ok: boolean; assetKeys: string[] }> {
	const universe = await ownedUniverseRow(db, userId, universeId, true);
	if (!universe) return { ok: false, assetKeys: [] };
	const assetKeys = await universeAssetKeys(db, universe.id);
	await db.transaction((tx) => purgeUniverseWithin(tx, universe.id));
	return { ok: true, assetKeys };
}

/** Universes whose trash window has elapsed and are due for the purge. */
export async function listUniversesDueForPurge(db: Database): Promise<string[]> {
	const rows = await db
		.select({ id: universes.id })
		.from(universes)
		.where(
			and(
				isNotNull(universes.deletedAt),
				lte(universes.deletedAt, sql`now() - make_interval(days => ${UNIVERSE_TRASH_DAYS})`)
			)
		);
	return rows.map((row) => row.id);
}

/** The bucket keys of everything the universe's purge will orphan. */
export async function universeAssetKeys(db: Database, universeId: string): Promise<string[]> {
	const rows = await db
		.select({ storageKey: assets.storageKey })
		.from(assets)
		.where(eq(assets.universeId, universeId));
	return rows.map((row) => row.storageKey);
}

/**
 * Hard-deletes a universe and everything in it, child-first, within the
 * caller's transaction. Shared by the trash purge and the account purge.
 */
export async function purgeUniverseWithin(tx: Tx, universeId: string): Promise<void> {
	// Stories first: each clears its scenes, chapters, markers, revisions,
	// outline, memberships, notes, publications, reviews, and mentions.
	const storyRows = await tx
		.select({ id: stories.id })
		.from(stories)
		.where(eq(stories.universeId, universeId));
	for (const story of storyRows) await deleteStoryWithin(tx, story.id);

	// Entity history is polymorphic (no FK), so it goes by the entity ids.
	const entityIds = [
		...(await tx
			.select({ id: characters.id })
			.from(characters)
			.where(eq(characters.universeId, universeId))),
		...(await tx.select({ id: places.id }).from(places).where(eq(places.universeId, universeId))),
		...(await tx
			.select({ id: loreEntries.id })
			.from(loreEntries)
			.where(eq(loreEntries.universeId, universeId)))
	].map((row) => row.id);
	if (entityIds.length > 0) {
		await tx.delete(revisions).where(inArray(revisions.entityId, entityIds));
	}

	// Relationships before their types, entities before their categories.
	await tx.delete(entityRelationships).where(eq(entityRelationships.universeId, universeId));
	await tx.delete(relationTypes).where(eq(relationTypes.universeId, universeId));
	await tx.delete(characters).where(eq(characters.universeId, universeId));
	await tx.delete(places).where(eq(places.universeId, universeId));
	await tx.delete(loreEntries).where(eq(loreEntries.universeId, universeId));
	await tx.delete(entityCategories).where(eq(entityCategories.universeId, universeId));
	await tx.delete(assets).where(eq(assets.universeId, universeId));
	await tx.delete(universes).where(eq(universes.id, universeId));
}
