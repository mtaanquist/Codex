// The universe-trash rule for lookups that do not go through ownedStory or
// ownedUniverse. Trashing a universe only stamps universes.deleted_at, so any
// query that reaches a story, scene, or entity by id must also check that its
// universe is live. Worker-safe: relative value imports carry explicit .ts
// extensions and nothing here touches $env.
import { and, eq, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Database } from './auth.ts';
import { universes } from './db/schema.ts';

/** A where-clause condition: the universe this column points at is not in the
 * trash. A correlated subquery, so it needs no join and works whatever the
 * outer query already joins. */
export function inLiveUniverse(universeId: AnyPgColumn): SQL {
	return sql`exists (select 1 from ${universes} where ${universes.id} = ${universeId} and ${universes.deletedAt} is null)`;
}

/** The universe if the user owns it and it is live, or, with deleted: true,
 * if the user owns it and it is in the trash. */
export async function ownedUniverseRow(
	db: Database,
	userId: string,
	universeId: string,
	options: { deleted?: boolean } = {}
): Promise<{ id: string } | null> {
	const [row] = await db
		.select({ id: universes.id })
		.from(universes)
		.where(
			and(
				eq(universes.id, universeId),
				eq(universes.ownerId, userId),
				options.deleted ? isNotNull(universes.deletedAt) : isNull(universes.deletedAt)
			)
		);
	return row ?? null;
}
