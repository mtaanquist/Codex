import { error, fail, redirect } from '@sveltejs/kit';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import {
	chapters,
	characters,
	entityMentions,
	loreEntries,
	places,
	scenes,
	stories,
	universes
} from '$lib/server/db/schema';
import { userPreferences } from '$lib/server/preferences';
import { getRevision, listRevisions, type RevisionRow } from '$lib/server/revisions';

async function ownedStory(storyId: string, userId: string) {
	const [row] = await db
		.select({ story: stories, universe: universes })
		.from(stories)
		.innerJoin(universes, eq(stories.universeId, universes.id))
		.where(and(eq(stories.id, storyId), eq(stories.ownerId, userId)));
	if (!row) error(404, 'Story not found');
	return row;
}

export const load: PageServerLoad = async ({ params, locals, url }) => {
	const { story, universe } = await ownedStory(params.id, locals.user!.id);

	const chapterList = await db
		.select()
		.from(chapters)
		.where(eq(chapters.storyId, story.id))
		.orderBy(asc(chapters.position));
	const sceneList = await db
		.select({
			id: scenes.id,
			chapterId: scenes.chapterId,
			title: scenes.title,
			status: scenes.status,
			wordCount: scenes.wordCount,
			globalPosition: scenes.globalPosition
		})
		.from(scenes)
		.where(eq(scenes.storyId, story.id))
		.orderBy(asc(scenes.globalPosition));

	// The story view renders every scene as one continuous document.
	const view = url.searchParams.get('view') === 'story' ? ('story' as const) : ('scene' as const);
	let storyDoc = null;
	if (view === 'story') {
		storyDoc = await db
			.select({
				id: scenes.id,
				chapterId: scenes.chapterId,
				title: scenes.title,
				bodyMd: scenes.bodyMd
			})
			.from(scenes)
			.where(eq(scenes.storyId, story.id))
			.orderBy(asc(scenes.globalPosition));
	}

	const selectedId = view === 'scene' ? url.searchParams.get('scene') : null;
	let selectedScene = null;
	if (selectedId) {
		const [row] = await db
			.select()
			.from(scenes)
			.where(and(eq(scenes.id, selectedId), eq(scenes.storyId, story.id)));
		selectedScene = row ?? null;
	}

	// The open scene's timeline, and the revision being previewed if the
	// URL names one. Both ride the scene's ownership check above.
	let sceneRevisions: RevisionRow[] = [];
	let revisionPreview = null;
	if (selectedScene) {
		sceneRevisions = await listRevisions(db, 'scene', selectedScene.id);
		const revisionId = url.searchParams.get('revision');
		if (revisionId) {
			revisionPreview = (await getRevision(db, revisionId, 'scene', selectedScene.id)) ?? null;
		}
	}

	// Who is mentioned in the open scene, read from the worker-built index.
	let inScene: { id: string; name: string; count: number }[] = [];
	if (selectedScene) {
		const mentionedCharacters = await db
			.select({
				id: characters.id,
				name: characters.name,
				count: sql<number>`count(*)::int`
			})
			.from(entityMentions)
			.innerJoin(characters, eq(entityMentions.targetId, characters.id))
			.where(
				and(
					eq(entityMentions.sourceType, 'scene'),
					eq(entityMentions.sourceId, selectedScene.id),
					eq(entityMentions.targetType, 'character')
				)
			)
			.groupBy(characters.id, characters.name);
		const mentionedPlaces = await db
			.select({
				id: places.id,
				name: places.name,
				count: sql<number>`count(*)::int`
			})
			.from(entityMentions)
			.innerJoin(places, eq(entityMentions.targetId, places.id))
			.where(
				and(
					eq(entityMentions.sourceType, 'scene'),
					eq(entityMentions.sourceId, selectedScene.id),
					eq(entityMentions.targetType, 'place')
				)
			)
			.groupBy(places.id, places.name);
		const mentionedLore = await db
			.select({
				id: loreEntries.id,
				name: loreEntries.title,
				count: sql<number>`count(*)::int`
			})
			.from(entityMentions)
			.innerJoin(loreEntries, eq(entityMentions.targetId, loreEntries.id))
			.where(
				and(
					eq(entityMentions.sourceType, 'scene'),
					eq(entityMentions.sourceId, selectedScene.id),
					eq(entityMentions.targetType, 'lore_entry')
				)
			)
			.groupBy(loreEntries.id, loreEntries.title);
		inScene = [...mentionedCharacters, ...mentionedPlaces, ...mentionedLore].sort((a, b) =>
			a.name.localeCompare(b.name)
		);
	}

	// Known entities feed the editor's live underlines and hover tooltips.
	const knownCharacters = await db
		.select({
			id: characters.id,
			name: characters.name,
			aliases: characters.aliases,
			summaryMd: characters.summaryMd
		})
		.from(characters)
		.where(and(eq(characters.universeId, universe.id), eq(characters.autoDetectMentions, true)));
	const knownPlaces = await db
		.select({ id: places.id, name: places.name, summaryMd: places.summaryMd })
		.from(places)
		.where(and(eq(places.universeId, universe.id), eq(places.autoDetectMentions, true)));
	const knownLore = await db
		.select({
			id: loreEntries.id,
			name: loreEntries.title,
			keywords: loreEntries.keywords,
			summaryMd: loreEntries.summaryMd
		})
		.from(loreEntries)
		.where(and(eq(loreEntries.universeId, universe.id), eq(loreEntries.autoDetectMentions, true)));
	const mentionEntities = [
		...knownCharacters,
		...knownPlaces.map((place) => ({ ...place, aliases: [] as string[] })),
		...knownLore.map((entry) => ({
			id: entry.id,
			name: entry.name,
			aliases: entry.keywords,
			summaryMd: entry.summaryMd
		}))
	];

	const preferences = await userPreferences(db, locals.user!.id);

	return {
		story,
		universe,
		user: locals.user!,
		preferences,
		chapters: chapterList,
		scenes: sceneList,
		selectedScene,
		sceneRevisions,
		revisionPreview,
		mentionEntities,
		inScene,
		view,
		storyDoc,
		// Carried through the story view so toggling back lands on the scene
		// that was open before.
		returnSceneId: url.searchParams.get('scene')
	};
};

export const actions: Actions = {
	createChapter: async ({ params, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		// Position computed inside the insert so concurrent creates cannot read
		// the same max.
		await db.insert(chapters).values({
			storyId: story.id,
			position: sql`(select coalesce(max(${chapters.position}), 0) + 1 from ${chapters} where ${chapters.storyId} = ${story.id})`
		});
		return { created: 'chapter' };
	},
	createScene: async ({ request, params, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		const chapterId = String(data.get('chapterId') ?? '') || null;
		if (chapterId) {
			const [chapter] = await db
				.select({ id: chapters.id })
				.from(chapters)
				.where(and(eq(chapters.id, chapterId), eq(chapters.storyId, story.id)));
			if (!chapter) return fail(400, { message: 'That chapter does not exist.' });
		}
		// Positions computed inside the insert so concurrent creates cannot read
		// the same max.
		const [scene] = await db
			.insert(scenes)
			.values({
				storyId: story.id,
				chapterId,
				positionInChapter: chapterId
					? sql`(select coalesce(max(${scenes.positionInChapter}), 0) + 1 from ${scenes} where ${scenes.chapterId} = ${chapterId})`
					: null,
				globalPosition: sql`(select coalesce(max(${scenes.globalPosition}), 0) + 1 from ${scenes} where ${scenes.storyId} = ${story.id})`
			})
			.returning({ id: scenes.id });
		redirect(303, `/stories/${story.id}?scene=${scene.id}`);
	}
};
