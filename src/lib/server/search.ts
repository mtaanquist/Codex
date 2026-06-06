import { and, asc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import type { Database } from './auth';
import { characters, loreEntries, places, scenes, stories, universes } from './db/schema';

// The command palette's search: everything the user owns that has a name,
// matched by substring, each result carrying the link that opens it.

export type SearchResult = {
	type: 'universe' | 'story' | 'scene' | 'character' | 'place' | 'lore';
	label: string;
	sublabel: string | null;
	href: string;
};

const PER_TYPE = 5;

// % and _ are wildcards inside ILIKE patterns; a literal search means
// escaping them.
function pattern(query: string): string {
	return `%${query.replace(/[\\%_]/g, '\\$&')}%`;
}

export async function searchAll(
	db: Database,
	userId: string,
	query: string
): Promise<SearchResult[]> {
	const trimmed = query.trim();
	if (trimmed === '') return [];
	const like = pattern(trimmed);

	const universeRows = await db
		.select({ id: universes.id, slug: universes.slug, name: universes.name })
		.from(universes)
		.where(and(eq(universes.ownerId, userId), ilike(universes.name, like)))
		.orderBy(asc(universes.name))
		.limit(PER_TYPE);

	const storyRows = await db
		.select({
			id: stories.id,
			slug: stories.slug,
			title: stories.title,
			universeName: universes.name
		})
		.from(stories)
		.innerJoin(universes, eq(stories.universeId, universes.id))
		.where(and(eq(stories.ownerId, userId), ilike(stories.title, like)))
		.orderBy(asc(stories.title))
		.limit(PER_TYPE);

	const sceneRows = await db
		.select({
			id: scenes.id,
			title: scenes.title,
			storySlug: stories.slug,
			storyTitle: stories.title
		})
		.from(scenes)
		.innerJoin(stories, eq(scenes.storyId, stories.id))
		.where(and(eq(stories.ownerId, userId), ilike(scenes.title, like), isNull(scenes.deletedAt)))
		.orderBy(asc(scenes.title))
		.limit(PER_TYPE);

	const characterRows = await db
		.select({
			id: characters.id,
			name: characters.name,
			universeSlug: universes.slug,
			universeName: universes.name
		})
		.from(characters)
		.innerJoin(universes, eq(characters.universeId, universes.id))
		.where(
			and(
				eq(characters.ownerId, userId),
				or(
					ilike(characters.name, like),
					sql`array_to_string(${characters.aliases}, ' ') ilike ${like}`
				)
			)
		)
		.orderBy(asc(characters.name))
		.limit(PER_TYPE);

	const placeRows = await db
		.select({
			id: places.id,
			name: places.name,
			universeSlug: universes.slug,
			universeName: universes.name
		})
		.from(places)
		.innerJoin(universes, eq(places.universeId, universes.id))
		.where(and(eq(places.ownerId, userId), ilike(places.name, like)))
		.orderBy(asc(places.name))
		.limit(PER_TYPE);

	const loreRows = await db
		.select({
			id: loreEntries.id,
			title: loreEntries.title,
			universeSlug: universes.slug,
			universeName: universes.name
		})
		.from(loreEntries)
		.innerJoin(universes, eq(loreEntries.universeId, universes.id))
		.where(
			and(
				eq(loreEntries.ownerId, userId),
				or(
					ilike(loreEntries.title, like),
					sql`array_to_string(${loreEntries.keywords}, ' ') ilike ${like}`
				)
			)
		)
		.orderBy(asc(loreEntries.title))
		.limit(PER_TYPE);

	return [
		...storyRows.map(
			(row): SearchResult => ({
				type: 'story',
				label: row.title,
				sublabel: row.universeName,
				href: `/stories/${row.slug}`
			})
		),
		...sceneRows.map(
			(row): SearchResult => ({
				type: 'scene',
				label: row.title ?? 'Untitled scene',
				sublabel: row.storyTitle,
				href: `/stories/${row.storySlug}?scene=${row.id}`
			})
		),
		...universeRows.map(
			(row): SearchResult => ({
				type: 'universe',
				label: row.name,
				sublabel: null,
				href: `/universes/${row.slug}/plan`
			})
		),
		...characterRows.map(
			(row): SearchResult => ({
				type: 'character',
				label: row.name,
				sublabel: row.universeName,
				href: `/universes/${row.universeSlug}/plan?entity=${row.id}`
			})
		),
		...placeRows.map(
			(row): SearchResult => ({
				type: 'place',
				label: row.name,
				sublabel: row.universeName,
				href: `/universes/${row.universeSlug}/plan?entity=${row.id}`
			})
		),
		...loreRows.map(
			(row): SearchResult => ({
				type: 'lore',
				label: row.title,
				sublabel: row.universeName,
				href: `/universes/${row.universeSlug}/plan?entity=${row.id}`
			})
		)
	];
}
