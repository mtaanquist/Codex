import { fail, redirect } from '@sveltejs/kit';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import {
	chapters,
	characters,
	characterStoryMemberships,
	entityMentions,
	loreEntries,
	places,
	placeStoryMemberships,
	scenes
} from '$lib/server/db/schema';
import { storyPreferences } from '$lib/server/preferences';
import { getRevision, listRevisions, type RevisionRow } from '$lib/server/revisions';
import { listSceneMarkers, listStoryMarkersByScene, listStoryTodos } from '$lib/server/markers';
import { listMentionPins } from '$lib/server/mention-pins';
import { ownedStory } from '$lib/server/story-access';
import {
	deleteChapter,
	destroyScene,
	listTrashedScenes,
	moveChapter,
	renameChapter,
	restoreScene,
	trashScene
} from '$lib/server/scene-lifecycle';
import { queueSceneMentions } from '$lib/server/jobs';

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
		.where(and(eq(scenes.storyId, story.id), isNull(scenes.deletedAt)))
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
			.where(and(eq(scenes.storyId, story.id), isNull(scenes.deletedAt)))
			.orderBy(asc(scenes.globalPosition));
	}

	const selectedId = view === 'scene' ? url.searchParams.get('scene') : null;
	let selectedScene = null;
	if (selectedId) {
		const [row] = await db
			.select()
			.from(scenes)
			.where(
				and(eq(scenes.id, selectedId), eq(scenes.storyId, story.id), isNull(scenes.deletedAt))
			);
		selectedScene = row ?? null;
	} else if (view === 'scene') {
		// Opening the story without naming a scene resumes the one edited last.
		const [row] = await db
			.select()
			.from(scenes)
			.where(and(eq(scenes.storyId, story.id), isNull(scenes.deletedAt)))
			.orderBy(desc(scenes.updatedAt))
			.limit(1);
		selectedScene = row ?? null;
	}

	// The open scene's timeline, and the revision being previewed if the
	// URL names one. Both ride the scene's ownership check above.
	let sceneRevisions: RevisionRow[] = [];
	let revisionPreview = null;
	let sceneMarkers: Awaited<ReturnType<typeof listSceneMarkers>> = [];
	if (selectedScene) {
		sceneRevisions = await listRevisions(db, 'scene', selectedScene.id);
		sceneMarkers = await listSceneMarkers(db, selectedScene.id);
		const revisionId = url.searchParams.get('revision');
		if (revisionId) {
			revisionPreview = (await getRevision(db, revisionId, 'scene', selectedScene.id)) ?? null;
		}
	}

	// Everything still to do across the story, for the right panel.
	const storyTodos = await listStoryTodos(db, story.id);

	// Marker highlights for the continuous view's stitched editors.
	const storyDocMarkers = view === 'story' ? await listStoryMarkersByScene(db, story.id) : {};

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
			summaryMd: characters.summaryMd,
			details: characters.details
		})
		.from(characters)
		.where(and(eq(characters.universeId, universe.id), eq(characters.autoDetectMentions, true)));
	const knownPlaces = await db
		.select({
			id: places.id,
			name: places.name,
			summaryMd: places.summaryMd,
			details: places.details
		})
		.from(places)
		.where(and(eq(places.universeId, universe.id), eq(places.autoDetectMentions, true)));
	const knownLore = await db
		.select({
			id: loreEntries.id,
			name: loreEntries.title,
			keywords: loreEntries.keywords,
			summaryMd: loreEntries.summaryMd,
			details: loreEntries.details
		})
		.from(loreEntries)
		.where(and(eq(loreEntries.universeId, universe.id), eq(loreEntries.autoDetectMentions, true)));
	const mentionEntities = [
		...knownCharacters.map((character) => ({ ...character, type: 'character' as const })),
		...knownPlaces.map((place) => ({
			...place,
			type: 'place' as const,
			aliases: [] as string[]
		})),
		...knownLore.map((entry) => ({
			id: entry.id,
			type: 'lore_entry' as const,
			name: entry.name,
			aliases: entry.keywords,
			summaryMd: entry.summaryMd,
			details: entry.details
		}))
	];

	// Disambiguation context: who is declared in this story, and the
	// author's pins for shared names.
	const memberRows = [
		...(await db
			.select({ id: characterStoryMemberships.characterId })
			.from(characterStoryMemberships)
			.where(eq(characterStoryMemberships.storyId, story.id))),
		...(await db
			.select({ id: placeStoryMemberships.placeId })
			.from(placeStoryMemberships)
			.where(eq(placeStoryMemberships.storyId, story.id)))
	];
	const mentionPins = Object.fromEntries(await listMentionPins(db, story.id));

	// The user's preferences with this story's overrides applied.
	const preferences = await storyPreferences(db, locals.user!.id, story.id);

	const trashedScenes = await listTrashedScenes(db, story.id);

	return {
		trashedScenes,
		story,
		universe,
		user: locals.user!,
		preferences,
		chapters: chapterList,
		scenes: sceneList,
		selectedScene,
		sceneRevisions,
		revisionPreview,
		sceneMarkers,
		storyTodos,
		storyDocMarkers,
		mentionEntities,
		mentionPins,
		storyMemberIds: memberRows.map((row) => row.id),
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
		redirect(303, `/stories/${story.slug}?scene=${scene.id}`);
	},
	renameChapter: async ({ request, params, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		const chapterId = String(data.get('chapterId') ?? '');
		const ok = await renameChapter(db, locals.user!.id, chapterId, String(data.get('title') ?? ''));
		if (!ok) return fail(404, { message: 'That chapter does not exist.' });
		// Keep the open scene open across the reload.
		redirect(303, sceneReturnPath(story.slug, data));
	},
	moveChapter: async ({ request, params, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		const chapterId = String(data.get('chapterId') ?? '');
		const direction = data.get('direction') === 'up' ? ('up' as const) : ('down' as const);
		const ok = await moveChapter(db, locals.user!.id, chapterId, direction);
		if (!ok) return fail(404, { message: 'That chapter does not exist.' });
		redirect(303, sceneReturnPath(story.slug, data));
	},
	deleteChapter: async ({ request, params, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		const chapterId = String(data.get('chapterId') ?? '');
		const ok = await deleteChapter(db, locals.user!.id, chapterId);
		if (!ok) return fail(404, { message: 'That chapter does not exist.' });
		redirect(303, sceneReturnPath(story.slug, data));
	},
	deleteScene: async ({ request, params, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		const sceneId = String(data.get('sceneId') ?? '');
		const ok = await trashScene(db, locals.user!.id, sceneId);
		if (!ok) return fail(404, { message: 'That scene does not exist.' });
		// Deleting the open scene closes it; deleting another keeps it open.
		const open = String(data.get('openSceneId') ?? '');
		redirect(
			303,
			open && open !== sceneId ? `/stories/${story.slug}?scene=${open}` : `/stories/${story.slug}`
		);
	},
	restoreScene: async ({ request, params, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		const sceneId = String(data.get('sceneId') ?? '');
		const ok = await restoreScene(db, locals.user!.id, sceneId);
		if (!ok) return fail(404, { message: 'That scene is not in the trash.' });
		await queueSceneMentions(sceneId);
		redirect(303, `/stories/${story.slug}?scene=${sceneId}`);
	},
	destroyScene: async ({ request, params, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		const sceneId = String(data.get('sceneId') ?? '');
		const ok = await destroyScene(db, locals.user!.id, sceneId);
		if (!ok) return fail(404, { message: 'That scene is not in the trash.' });
		redirect(303, sceneReturnPath(story.slug, data));
	}
};

// Where a sidebar action lands after the reload: back on the open scene when
// the form carried one, the story page otherwise.
function sceneReturnPath(slug: string, data: FormData): string {
	const open = String(data.get('openSceneId') ?? '');
	return open ? `/stories/${slug}?scene=${open}` : `/stories/${slug}`;
}
