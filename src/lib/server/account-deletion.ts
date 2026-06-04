import { and, eq, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import type { Database } from './auth';
import type { AssetObjectStore } from './assets';
import {
	assets,
	characters,
	entityCategories,
	entityRelationships,
	loreEntries,
	places,
	publications,
	sessions,
	stories,
	totpRecoveryCodes,
	universes,
	userTotp,
	users,
	authTokens
} from './db/schema.ts';
import { deleteStoryWithin } from './story-delete.ts';
import { consumeToken, issueToken } from './tokens.ts';

const GRACE_DAYS = 7;
const GRACE_MS = GRACE_DAYS * 24 * 60 * 60 * 1000;

export const DELETION_GRACE_DAYS = GRACE_DAYS;

// Schedules self-service deletion: the account is deactivated at once (sign-in
// blocked, live sessions dropped) and its public editions taken down right
// away, with the hard purge deferred by the grace window. Returns a one-time
// cancellation token for the emailed link.
export async function scheduleAccountDeletion(db: Database, userId: string): Promise<string> {
	await db.transaction(async (tx) => {
		const scheduled = new Date(Date.now() + GRACE_MS);
		await tx
			.update(users)
			.set({ deletionScheduledAt: scheduled, suspendedAt: sql`now()` })
			.where(eq(users.id, userId));
		await tx
			.update(sessions)
			.set({ revokedAt: sql`now()` })
			.where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
		// Public editions come down immediately - the public-facing erasure must
		// be prompt even though the rows are purged after the grace window.
		await tx
			.update(publications)
			.set({ removedAt: sql`now()` })
			.where(and(eq(publications.ownerId, userId), isNull(publications.removedAt)));
	});
	return issueToken(db, userId, 'deletion_cancel', GRACE_DAYS * 24 * 60);
}

// Cancels a scheduled deletion if the token is valid, reactivating the account.
// Editions stay down (the user can republish); restoring them is not automatic.
export async function cancelAccountDeletion(db: Database, token: string): Promise<boolean> {
	const userId = await consumeToken(db, 'deletion_cancel', token);
	if (!userId) return false;
	await db
		.update(users)
		.set({ deletionScheduledAt: null, suspendedAt: null })
		.where(eq(users.id, userId));
	return true;
}

// Accounts whose grace window has elapsed and are due for the hard purge.
export async function listAccountsDueForPurge(db: Database): Promise<string[]> {
	const rows = await db
		.select({ id: users.id })
		.from(users)
		.where(and(isNotNull(users.deletionScheduledAt), lte(users.deletionScheduledAt, sql`now()`)));
	return rows.map((row) => row.id);
}

// Hard-deletes an account and everything it owns, irreversibly. Every owned row
// goes in one transaction in dependency order; the uploaded image objects are
// removed from the bucket afterwards (best-effort - an orphaned object is swept
// later, never a blocker). Used by the scheduled purge and by admin deletion.
export async function purgeAccount(
	db: Database,
	userId: string,
	store: AssetObjectStore | null
): Promise<void> {
	// Capture the bucket keys before the rows go.
	const assetRows = await db
		.select({ storageKey: assets.storageKey })
		.from(assets)
		.where(eq(assets.ownerId, userId));

	await db.transaction(async (tx) => {
		// Stories first: this clears scenes, chapters, markers, revisions,
		// outline, memberships, story notes, publications, and mention rows.
		const storyRows = await tx
			.select({ id: stories.id })
			.from(stories)
			.innerJoin(universes, eq(stories.universeId, universes.id))
			.where(eq(universes.ownerId, userId));
		for (const story of storyRows) await deleteStoryWithin(tx, story.id);

		const universeRows = await tx
			.select({ id: universes.id })
			.from(universes)
			.where(eq(universes.ownerId, userId));
		const universeIds = universeRows.map((row) => row.id);
		if (universeIds.length > 0) {
			// Universe-wide relationships (story-scoped ones went with the stories).
			await tx
				.delete(entityRelationships)
				.where(inArray(entityRelationships.universeId, universeIds));
			// Assets reference the universe, and stories' cover references are
			// already gone, so the rows can be removed before the universe.
			await tx.delete(assets).where(eq(assets.ownerId, userId));
			// Entities before their categories (characters/places reference them).
			await tx.delete(characters).where(inArray(characters.universeId, universeIds));
			await tx.delete(places).where(inArray(places.universeId, universeIds));
			await tx.delete(loreEntries).where(inArray(loreEntries.universeId, universeIds));
			await tx.delete(entityCategories).where(inArray(entityCategories.universeId, universeIds));
			await tx.delete(universes).where(inArray(universes.id, universeIds));
		} else {
			// No universes, but the account may still own stray assets.
			await tx.delete(assets).where(eq(assets.ownerId, userId));
		}

		await tx.delete(authTokens).where(eq(authTokens.userId, userId));
		await tx.delete(totpRecoveryCodes).where(eq(totpRecoveryCodes.userId, userId));
		await tx.delete(userTotp).where(eq(userTotp.userId, userId));
		await tx.delete(sessions).where(eq(sessions.userId, userId));
		await tx.delete(users).where(eq(users.id, userId));
	});

	if (store) {
		for (const asset of assetRows) await store.remove(asset.storageKey).catch(() => {});
	}
}
