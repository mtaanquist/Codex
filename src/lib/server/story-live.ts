import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from './auth';
import {
	characters,
	entityCategories,
	entityMentions,
	loreEntries,
	places,
	scenes
} from './db/schema';
import { listStoryTodos } from './markers';
import { listRevisions, type RevisionRow } from './revisions';

export type InSceneEntity = {
	id: string;
	name: string;
	count: number;
	kind: 'character' | 'place' | 'lore';
	categoryColor: string | null;
	badgeColor: string | null;
	badgeAssetId: string | null;
};

// The parts of the story page a scene save changes: word counts and titles,
// the to-do list, and the open scene's history and mentions. The page load
// reads them with everything else; after a save the page re-reads only these
// (see the story route's +page.ts), so typing does not reload the whole story.
export async function loadStoryLive(
	db: Database,
	ids: { storyId: string; universeId: string; sceneId: string | null }
) {
	const [siblingResult, sceneList, storyTodos, sceneLive] = await Promise.all([
		// The sidebar's book switcher: every story in the universe, with the
		// chapter and word counts its menu rows show.
		db.execute(sql`
			select st.id, st.slug, st.title,
				(select count(*)::int from chapters c where c.story_id = st.id) as chapters,
				coalesce(
					(select sum(s.word_count)::int from scenes s
						where s.story_id = st.id and s.deleted_at is null),
					0
				) as words
			from stories st
			where st.universe_id = ${ids.universeId} and st.deleted_at is null
			order by st.position_in_series asc nulls last, st.created_at asc
		`),
		db
			.select({
				id: scenes.id,
				chapterId: scenes.chapterId,
				title: scenes.title,
				status: scenes.status,
				wordCount: scenes.wordCount,
				globalPosition: scenes.globalPosition
			})
			.from(scenes)
			.where(and(eq(scenes.storyId, ids.storyId), isNull(scenes.deletedAt)))
			.orderBy(asc(scenes.globalPosition)),
		// Everything still to do across the story, for the right panel.
		listStoryTodos(db, ids.storyId),
		ids.sceneId ? loadSceneLive(db, ids.sceneId) : Promise.resolve(null)
	]);
	const storySiblings = siblingResult.rows.map((row) => {
		const r = row as { id: string; slug: string; title: string; chapters: number; words: number };
		return { id: r.id, slug: r.slug, title: r.title, chapters: r.chapters, words: r.words };
	});
	return {
		storySiblings,
		scenes: sceneList,
		storyTodos,
		sceneRevisions: sceneLive?.revisions ?? ([] as RevisionRow[]),
		inScene: sceneLive?.inScene ?? ([] as InSceneEntity[])
	};
}

// The open scene's timeline and who is mentioned in it (read from the
// worker-built index).
export async function loadSceneLive(db: Database, sceneId: string) {
	const mentionCounts = (
		table: typeof characters | typeof places | typeof loreEntries,
		targetType: 'character' | 'place' | 'lore_entry'
	) => {
		const nameColumn = 'name' in table ? table.name : loreEntries.title;
		return db
			.select({
				id: table.id,
				name: nameColumn,
				count: sql<number>`count(*)::int`,
				categoryColor: entityCategories.color,
				badgeColor: table.badgeColor,
				badgeAssetId: table.badgeAssetId
			})
			.from(entityMentions)
			.innerJoin(table, eq(entityMentions.targetId, table.id))
			.leftJoin(entityCategories, eq(table.categoryId, entityCategories.id))
			.where(
				and(
					eq(entityMentions.sourceType, 'scene'),
					eq(entityMentions.sourceId, sceneId),
					eq(entityMentions.targetType, targetType)
				)
			)
			.groupBy(table.id, nameColumn, entityCategories.color, table.badgeColor, table.badgeAssetId);
	};
	const [revisions, mentionedCharacters, mentionedPlaces, mentionedLore] = await Promise.all([
		listRevisions(db, 'scene', sceneId),
		mentionCounts(characters, 'character'),
		mentionCounts(places, 'place'),
		mentionCounts(loreEntries, 'lore_entry')
	]);
	// Tagged with the kind so the panel can group them by entity type.
	const inScene: InSceneEntity[] = [
		...mentionedCharacters.map((row) => ({ ...row, kind: 'character' as const })),
		...mentionedPlaces.map((row) => ({ ...row, kind: 'place' as const })),
		...mentionedLore.map((row) => ({ ...row, kind: 'lore' as const }))
	].sort((a, b) => a.name.localeCompare(b.name));
	return { revisions, inScene };
}

// The open scene's own fields a save changes. The editor already holds the
// text; the page needs the title, count and the mention index watermark.
export async function loadSceneMeta(db: Database, storyId: string, sceneId: string) {
	const [row] = await db
		.select({
			title: scenes.title,
			wordCount: scenes.wordCount,
			bodyMd: scenes.bodyMd,
			updatedAt: scenes.updatedAt,
			mentionsIndexedAt: scenes.mentionsIndexedAt
		})
		.from(scenes)
		.where(and(eq(scenes.id, sceneId), eq(scenes.storyId, storyId), isNull(scenes.deletedAt)));
	return row ?? null;
}

// What the live endpoint answers, before JSON turns the dates into strings.
export type StoryLiveResponse = Awaited<ReturnType<typeof loadStoryLive>> & {
	sceneMeta: Awaited<ReturnType<typeof loadSceneMeta>> | null;
};
