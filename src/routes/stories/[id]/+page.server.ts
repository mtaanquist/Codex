import { fail, redirect } from '@sveltejs/kit';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import {
	chapters,
	characters,
	entityCategories,
	entityMentions,
	loreEntries,
	places,
	scenes
} from '$lib/server/db/schema';
import { storyPreferences } from '$lib/server/preferences';
import { storyPageSetup } from '$lib/server/page-setup';
import { getRevision, listRevisions, type RevisionRow } from '$lib/server/revisions';
import { listSceneMarkers, listStoryMarkersByScene, listStoryTodos } from '$lib/server/markers';
import { reviewMentionData } from '$lib/server/mention-entities';
import { ownedStory } from '$lib/server/story-access';
import { isUuid } from '$lib/slug';
import { assistantLayout, saveStoryLlmOverride } from '$lib/server/llm/config';
import { listChat } from '$lib/server/llm/chat-history';
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

	// scene: edit one scene; story: the continuous editor; preview: the
	// read-only, export-faithful render of the whole story.
	const viewParam = url.searchParams.get('view');
	const view =
		viewParam === 'story'
			? ('story' as const)
			: viewParam === 'preview'
				? ('preview' as const)
				: ('scene' as const);
	const wholeStory = view === 'story' || view === 'preview';
	const selectedId = view === 'scene' ? url.searchParams.get('scene') : null;

	// The open scene: the named one, or - opening the story bare - the one
	// edited last.
	const selectScene = async () => {
		if (view !== 'scene') return null;
		// A non-uuid ?scene= would throw on the uuid cast; fall back to the
		// last-edited scene instead of 500ing.
		if (selectedId && isUuid(selectedId)) {
			const [row] = await db
				.select()
				.from(scenes)
				.where(
					and(eq(scenes.id, selectedId), eq(scenes.storyId, story.id), isNull(scenes.deletedAt))
				);
			return row ?? null;
		}
		const [row] = await db
			.select()
			.from(scenes)
			.where(and(eq(scenes.storyId, story.id), isNull(scenes.deletedAt)))
			.orderBy(desc(scenes.updatedAt))
			.limit(1);
		return row ?? null;
	};

	// Everything below needs only the story and universe ids, so it runs as
	// one parallel wave instead of a dozen serial round-trips - this is the
	// hottest navigation path in the app (review finding #193).
	const [
		siblingResult,
		chapterList,
		sceneList,
		storyDoc,
		selectedScene,
		storyTodos,
		storyDocMarkers,
		mentionData,
		loreCategories,
		preferences,
		trashedScenes,
		pageSetup,
		assistant
	] = await Promise.all([
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
			where st.universe_id = ${universe.id}
			order by st.position_in_series asc nulls last, st.created_at asc
		`),
		db
			.select()
			.from(chapters)
			.where(eq(chapters.storyId, story.id))
			.orderBy(asc(chapters.position)),
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
			.where(and(eq(scenes.storyId, story.id), isNull(scenes.deletedAt)))
			.orderBy(asc(scenes.globalPosition)),
		// The story and preview views render every scene as one document.
		wholeStory
			? db
					.select({
						id: scenes.id,
						chapterId: scenes.chapterId,
						title: scenes.title,
						bodyMd: scenes.bodyMd
					})
					.from(scenes)
					.where(and(eq(scenes.storyId, story.id), isNull(scenes.deletedAt)))
					.orderBy(asc(scenes.globalPosition))
			: Promise.resolve(null),
		selectScene(),
		// Everything still to do across the story, for the right panel.
		listStoryTodos(db, story.id),
		// Marker highlights for the continuous view's stitched editors.
		view === 'story'
			? listStoryMarkersByScene(db, story.id)
			: Promise.resolve({} as Awaited<ReturnType<typeof listStoryMarkersByScene>>),
		// Known entities feed the editor's live underlines, the autocomplete, and
		// the hover cards (category colour and name drive the badges, related
		// lists become the card's chips), together with the disambiguation
		// context (story members and the author's pins for shared names). The
		// review surface uses the same shape; this is the shared loader, with the
		// full cast since the author sees everything.
		reviewMentionData(db, {
			universeId: universe.id,
			storyId: story.id,
			sceneIds: [],
			restrictToMentioned: false
		}),
		// The selection menu's lore submenu offers every category.
		db
			.select({ id: entityCategories.id, name: entityCategories.name })
			.from(entityCategories)
			.where(eq(entityCategories.universeId, universe.id))
			.orderBy(asc(entityCategories.sortOrder), asc(entityCategories.name)),
		// The user's preferences with this story's overrides applied.
		storyPreferences(db, locals.user!.id, story.id),
		listTrashedScenes(db, story.id),
		// The preview honours the story's scene break and paragraph style so it
		// matches the export.
		view === 'preview' ? storyPageSetup(db, story.id) : Promise.resolve(null),
		// What Assistant UI to render: the tab, whether surfaces are live, the
		// per-story mute, the Assistant's name. Absent entirely when not enabled,
		// the way asset-backed features hide when no bucket is configured.
		assistantLayout(db, locals.user!.id, story.id)
	]);

	const storySiblings = siblingResult.rows.map((row) => {
		const r = row as { id: string; slug: string; title: string; chapters: number; words: number };
		return { id: r.id, slug: r.slug, title: r.title, chapters: r.chapters, words: r.words };
	});
	const {
		entities: mentionEntities,
		storyMembers: storyMemberIds,
		pins: mentionPins
	} = mentionData;

	// The scene-keyed wave: timeline, markers, preview, and who is mentioned
	// in the open scene (read from the worker-built index).
	let sceneRevisions: RevisionRow[] = [];
	let revisionPreview = null;
	let sceneMarkers: Awaited<ReturnType<typeof listSceneMarkers>> = [];
	type InSceneKind = 'character' | 'place' | 'lore';
	let inScene: {
		id: string;
		name: string;
		count: number;
		kind: InSceneKind;
		categoryColor: string | null;
		badgeColor: string | null;
		badgeAssetId: string | null;
	}[] = [];
	if (selectedScene) {
		const revisionParam = url.searchParams.get('revision');
		// Guard the uuid cast, the same as ?scene above.
		const revisionId = revisionParam && isUuid(revisionParam) ? revisionParam : null;
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
						eq(entityMentions.sourceId, selectedScene.id),
						eq(entityMentions.targetType, targetType)
					)
				)
				.groupBy(
					table.id,
					nameColumn,
					entityCategories.color,
					table.badgeColor,
					table.badgeAssetId
				);
		};
		const [revs, markers, preview, mentionedCharacters, mentionedPlaces, mentionedLore] =
			await Promise.all([
				listRevisions(db, 'scene', selectedScene.id),
				listSceneMarkers(db, selectedScene.id),
				revisionId ? getRevision(db, revisionId, 'scene', selectedScene.id) : Promise.resolve(null),
				mentionCounts(characters, 'character'),
				mentionCounts(places, 'place'),
				mentionCounts(loreEntries, 'lore_entry')
			]);
		sceneRevisions = revs;
		sceneMarkers = markers;
		revisionPreview = preview ?? null;
		// Tagged with the kind so the panel can group them by entity type.
		inScene = [
			...mentionedCharacters.map((row) => ({ ...row, kind: 'character' as const })),
			...mentionedPlaces.map((row) => ({ ...row, kind: 'place' as const })),
			...mentionedLore.map((row) => ({ ...row, kind: 'lore' as const }))
		].sort((a, b) => a.name.localeCompare(b.name));
	}

	// The stored conversation seeds the Assistant tab; nothing to load while
	// the tab is gated off.
	const assistantChat = assistant.tabEnabled ? await listChat(db, locals.user!.id, story.id) : [];

	return {
		trashedScenes,
		story,
		universe,
		preferences,
		assistantChat,
		storySiblings,
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
		loreCategories,
		storyMemberIds,
		inScene,
		view,
		storyDoc,
		pageSetup,
		assistant,
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
		// Guard the uuid cast: a tampered id would throw in Postgres and 500.
		if (chapterId && !isUuid(chapterId)) {
			return fail(400, { message: 'That chapter does not exist.' });
		}
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
		if (!isUuid(chapterId)) return fail(404, { message: 'That chapter does not exist.' });
		const ok = await renameChapter(db, locals.user!.id, chapterId, String(data.get('title') ?? ''));
		if (!ok) return fail(404, { message: 'That chapter does not exist.' });
		// Keep the open scene open across the reload.
		redirect(303, sceneReturnPath(story.slug, data));
	},
	moveChapter: async ({ request, params, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		const chapterId = String(data.get('chapterId') ?? '');
		if (!isUuid(chapterId)) return fail(404, { message: 'That chapter does not exist.' });
		const direction = data.get('direction') === 'up' ? ('up' as const) : ('down' as const);
		const ok = await moveChapter(db, locals.user!.id, chapterId, direction);
		if (!ok) return fail(404, { message: 'That chapter does not exist.' });
		redirect(303, sceneReturnPath(story.slug, data));
	},
	deleteChapter: async ({ request, params, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		const chapterId = String(data.get('chapterId') ?? '');
		if (!isUuid(chapterId)) return fail(404, { message: 'That chapter does not exist.' });
		const ok = await deleteChapter(db, locals.user!.id, chapterId);
		if (!ok) return fail(404, { message: 'That chapter does not exist.' });
		redirect(303, sceneReturnPath(story.slug, data));
	},
	deleteScene: async ({ request, params, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		const sceneId = String(data.get('sceneId') ?? '');
		if (!isUuid(sceneId)) return fail(404, { message: 'That scene does not exist.' });
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
		if (!isUuid(sceneId)) return fail(404, { message: 'That scene is not in the trash.' });
		const ok = await restoreScene(db, locals.user!.id, sceneId);
		if (!ok) return fail(404, { message: 'That scene is not in the trash.' });
		await queueSceneMentions(sceneId);
		redirect(303, `/stories/${story.slug}?scene=${sceneId}`);
	},
	destroyScene: async ({ request, params, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		const sceneId = String(data.get('sceneId') ?? '');
		if (!isUuid(sceneId)) return fail(404, { message: 'That scene is not in the trash.' });
		const ok = await destroyScene(db, locals.user!.id, sceneId);
		if (!ok) return fail(404, { message: 'That scene is not in the trash.' });
		redirect(303, sceneReturnPath(story.slug, data));
	},
	// The per-story mute on the Assistant tab. A story can only subtract: muting
	// writes enabled:false, un-muting clears the override so the story follows
	// the account again. Neither can light the Assistant up when the account is
	// off (the master is the kill switch). The default enhance reloads the page,
	// so the gate re-renders.
	muteAssistant: async ({ params, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		await saveStoryLlmOverride(db, story.id, { enabled: false });
		return { scope: 'assistant-mute' };
	},
	unmuteAssistant: async ({ params, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		await saveStoryLlmOverride(db, story.id, { enabled: null });
		return { scope: 'assistant-mute' };
	}
};

// Where a sidebar action lands after the reload: back on the open scene when
// the form carried one, the story page otherwise.
function sceneReturnPath(slug: string, data: FormData): string {
	const open = String(data.get('openSceneId') ?? '');
	return open ? `/stories/${slug}?scene=${open}` : `/stories/${slug}`;
}
