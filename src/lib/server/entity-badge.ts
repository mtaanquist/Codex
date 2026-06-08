import { and, eq } from 'drizzle-orm';
import type { Database } from './auth';
import { characters, loreEntries, places } from './db/schema';
import type { EntityType } from './entity-lookups';
import { createAsset, deleteAsset, type AssetConfig, type AssetObjectStore } from './assets';
import { isCategoryColor } from '$lib/entity-color';

// The per-entity badge: a palette colour, or an uploaded image (the image
// wins). Both live on the entity row. These helpers resolve an entity id to
// whichever of the three tables holds it, owner-scoped, and update it; the
// image path mirrors the avatar flow (create, swap the reference, delete the
// old). Entities are only ever removed by the universe purge, which sweeps
// their assets by universeId, so there is no per-entity asset cleanup here.

type EntityRef = { type: EntityType; universeId: string; badgeAssetId: string | null };

async function resolveOwnedEntity(
	db: Database,
	userId: string,
	entityId: string
): Promise<EntityRef | null> {
	const [character] = await db
		.select({ universeId: characters.universeId, badgeAssetId: characters.badgeAssetId })
		.from(characters)
		.where(and(eq(characters.id, entityId), eq(characters.ownerId, userId)));
	if (character) return { type: 'character', ...character };
	const [place] = await db
		.select({ universeId: places.universeId, badgeAssetId: places.badgeAssetId })
		.from(places)
		.where(and(eq(places.id, entityId), eq(places.ownerId, userId)));
	if (place) return { type: 'place', ...place };
	const [lore] = await db
		.select({ universeId: loreEntries.universeId, badgeAssetId: loreEntries.badgeAssetId })
		.from(loreEntries)
		.where(and(eq(loreEntries.id, entityId), eq(loreEntries.ownerId, userId)));
	if (lore) return { type: 'lore_entry', ...lore };
	return null;
}

async function updateBadge(
	db: Database,
	type: EntityType,
	entityId: string,
	patch: { badgeColor?: string | null; badgeAssetId?: string | null }
): Promise<void> {
	if (type === 'character') {
		await db.update(characters).set(patch).where(eq(characters.id, entityId));
	} else if (type === 'place') {
		await db.update(places).set(patch).where(eq(places.id, entityId));
	} else {
		await db.update(loreEntries).set(patch).where(eq(loreEntries.id, entityId));
	}
}

export type BadgeResult = { ok: true } | { ok: false; reason: string };

// Sets (or clears, with null) the entity's badge colour. A colour and an
// uploaded image are independent on the row; the image just renders on top.
export async function setEntityBadgeColor(
	db: Database,
	userId: string,
	entityId: string,
	color: string | null
): Promise<BadgeResult> {
	if (!isCategoryColor(color)) return { ok: false, reason: 'not a valid badge colour' };
	const ref = await resolveOwnedEntity(db, userId, entityId);
	if (!ref) return { ok: false, reason: 'entity not found' };
	await updateBadge(db, ref.type, entityId, { badgeColor: color });
	return { ok: true };
}

// Uploads a badge image, points the entity at it, and deletes the old one.
export async function setEntityBadgeImage(
	db: Database,
	store: AssetObjectStore,
	config: AssetConfig,
	userId: string,
	entityId: string,
	input: { filename: string; contentType: string; bytes: Buffer }
): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
	const ref = await resolveOwnedEntity(db, userId, entityId);
	if (!ref) return { ok: false, reason: 'entity not found' };
	const created = await createAsset(db, store, config, userId, {
		universeId: ref.universeId,
		kind: 'badge',
		filename: input.filename,
		contentType: input.contentType,
		bytes: input.bytes
	});
	if (!created.ok) return created;
	await updateBadge(db, ref.type, entityId, { badgeAssetId: created.id });
	if (ref.badgeAssetId) await deleteAsset(db, store, userId, ref.badgeAssetId);
	return { ok: true, id: created.id };
}

// Clears the entity's badge image and deletes the stored object.
export async function clearEntityBadgeImage(
	db: Database,
	store: AssetObjectStore,
	userId: string,
	entityId: string
): Promise<BadgeResult> {
	const ref = await resolveOwnedEntity(db, userId, entityId);
	if (!ref) return { ok: false, reason: 'entity not found' };
	if (ref.badgeAssetId) {
		await updateBadge(db, ref.type, entityId, { badgeAssetId: null });
		await deleteAsset(db, store, userId, ref.badgeAssetId);
	}
	return { ok: true };
}
