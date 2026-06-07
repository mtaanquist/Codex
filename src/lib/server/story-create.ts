import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from './auth';
import { isUniqueViolation } from './db';
import { entityCategories, stories, universes } from './db/schema';
import { uniqueSlug } from './slugs';

// Creates a story with a readable slug, shared by the library's new-story
// card and the universe plan board. Retries once when a concurrent create
// takes the picked slug between the pick and the insert.
export async function createStoryInUniverse(
	db: Database,
	ownerId: string,
	universeId: string,
	title: string
) {
	const create = (slug: string) =>
		db.insert(stories).values({ universeId, ownerId, title, slug }).returning();
	try {
		const [story] = await create(await uniqueSlug(db, 'stories', ownerId, title, 'story'));
		return story;
	} catch (err) {
		if (!isUniqueViolation(err)) throw err;
		const [story] = await create(await uniqueSlug(db, 'stories', ownerId, title, 'story'));
		return story;
	}
}

// The home for stories that do not fit a universe: one per owner, created
// lazily the first time it is needed. A full universe like any other, so
// characters, mentions, export, and publishing all keep working; a partial
// unique index keeps concurrent first uses to a single row.
export const STANDALONE_UNIVERSE_NAME = 'Standalone stories';

export async function standaloneUniverse(db: Database, ownerId: string) {
	const existing = await db
		.select()
		.from(universes)
		.where(
			and(
				eq(universes.ownerId, ownerId),
				eq(universes.standalone, true),
				isNull(universes.deletedAt)
			)
		);
	if (existing.length > 0) return existing[0];
	try {
		const [created] = await db
			.insert(universes)
			.values({
				ownerId,
				name: STANDALONE_UNIVERSE_NAME,
				slug: await uniqueSlug(db, 'universes', ownerId, STANDALONE_UNIVERSE_NAME, 'universe'),
				standalone: true
			})
			.returning();
		// The same starter categories every universe gets, so lore entries
		// (which need a category) work here too.
		await db.insert(entityCategories).values([
			{ universeId: created.id, ownerId, name: 'Lore', sortOrder: 0 },
			{ universeId: created.id, ownerId, name: 'Faction', sortOrder: 1 }
		]);
		return created;
	} catch (err) {
		// A concurrent request created it between the select and the insert.
		if (!isUniqueViolation(err)) throw err;
		const [winner] = await db
			.select()
			.from(universes)
			.where(and(eq(universes.ownerId, ownerId), eq(universes.standalone, true)));
		return winner;
	}
}
