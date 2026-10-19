// The trash rules for lookups that do not go through ownedStory or
// ownedUniverse. Trashing a universe or a story only stamps its deleted_at, so
// any query that reaches a story, scene, or entity by id must also check that
// its universe (and, for story content, its story) is live. Worker-safe: relative value imports carry explicit .ts
// extensions and nothing here touches $env.
import { and, eq, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Database } from './auth.ts';
import { notes, stories, universes } from './db/schema.ts';

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

/** A where-clause condition for a query with stories in its FROM: the story
 * is not in the trash and neither is its universe. */
export function storyIsLive(): SQL {
	return sql`(${stories.deletedAt} is null and ${inLiveUniverse(stories.universeId)})`;
}

/** A where-clause condition: the story this column points at is live and so
 * is its universe. Aliased tables keep the correlation safe when the outer
 * query also reads stories. */
export function inLiveStory(storyId: AnyPgColumn): SQL {
	return sql`exists (select 1 from stories live_story join universes live_universe on live_universe.id = live_story.universe_id where live_story.id = ${storyId} and live_story.deleted_at is null and live_universe.deleted_at is null)`;
}

/** A where-clause condition for a query with notes in its FROM: the note's
 * universe is live and, for a story note, so is its story. */
export function noteIsLive(): SQL {
	return sql`(${inLiveUniverse(notes.universeId)} and (${notes.storyId} is null or ${inLiveStory(notes.storyId)}))`;
}
