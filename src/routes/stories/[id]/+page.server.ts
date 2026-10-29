import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '#lib/server/db';
import { chapters, entityCategories, scenes } from '#lib/server/db/schema';
import { storyPreferences } from '#lib/server/preferences';
import { storyPageSetup } from '#lib/server/page-setup';
import { getRevision, type RevisionRow } from '#lib/server/revisions';
import { listSceneMarkers, listStoryMarkersByScene } from '#lib/server/markers';
import { loadSceneLive, loadStoryLive, type InSceneEntity } from '#lib/server/story-live';
import { reviewMentionData } from '#lib/server/mention-entities';
import { ownedStory } from '#lib/server/story-access';
import { readingPageRef } from '#lib/server/publish';
import { createSceneNote, listSceneNotes, listStoryNotes } from '#lib/server/notes';
import { isUuid } from '#lib/slug';
import { assistantLayout, saveStoryLlmOverride } from '#lib/server/llm/config';
import { listChat } from '#lib/server/llm/chat-history';
import { hasChatSummary } from '#lib/server/llm/chat-summary';
import { listTrashedScenes } from '#lib/server/scene-lifecycle';
import { sceneManageActions } from '#lib/server/scene-manage-actions';
import { formText } from '#lib/server/validation';

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
		live,
		chapterList,
		storyDoc,
		selectedScene,
		storyDocMarkers,
		mentionData,
		loreCategories,
		preferences,
		trashedScenes,
		pageSetup,
		assistant,
		storyNotes
	] = await Promise.all([
		// Sibling stories, the scene list and the to-do list (sceneless here;
		// the open scene's part follows once it is known).
		loadStoryLive(db, { storyId: story.id, universeId: universe.id, sceneId: null }),
		db
			.select()
			.from(chapters)
			.where(eq(chapters.storyId, story.id))
			.orderBy(asc(chapters.position)),
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
		// Loaded for every editor view, not just preview: the editor shows the
		// story's default text alignment, and the preview also honours the scene
		// break and paragraph style so it matches the export.
		storyPageSetup(db, story.id),
		// What Assistant UI to render: the tab, whether surfaces are live, the
		// per-story mute, the Assistant's name. Absent entirely when not enabled,
		// the way asset-backed features hide when no bucket is configured.
		assistantLayout(db, locals.user!.id, story.id),
		// The Notes panel's story-wide list; the Notes page is reached from it.
		listStoryNotes(db, story.id, locals.user!.id)
	]);

	const { storySiblings, scenes: sceneList, storyTodos } = live;
	const {
		entities: mentionEntities,
		storyMembers: storyMemberIds,
		pins: mentionPins
	} = mentionData;

	// The scene-keyed wave: timeline, markers, preview, and who is mentioned
	// in the open scene (read from the worker-built index).
	let sceneNotes: Awaited<ReturnType<typeof listSceneNotes>> = [];
	let sceneRevisions: RevisionRow[] = [];
	let revisionPreview = null;
	let sceneMarkers: Awaited<ReturnType<typeof listSceneMarkers>> = [];
	let inScene: InSceneEntity[] = [];
	if (selectedScene) {
		const revisionParam = url.searchParams.get('revision');
		// Guard the uuid cast, the same as ?scene above.
		const revisionId = revisionParam && isUuid(revisionParam) ? revisionParam : null;
		const [sceneLive, markers, preview, notesOnScene] = await Promise.all([
			loadSceneLive(db, selectedScene.id),
			listSceneMarkers(db, selectedScene.id),
			revisionId ? getRevision(db, revisionId, 'scene', selectedScene.id) : Promise.resolve(null),
			// The Notes panel: what is written about this scene, not the story.
			listSceneNotes(db, selectedScene.id, locals.user!.id)
		]);
		sceneRevisions = sceneLive.revisions;
		inScene = sceneLive.inScene;
		sceneMarkers = markers;
		revisionPreview = preview ?? null;
		sceneNotes = notesOnScene;
	}

	// The stored conversation seeds the Assistant tab; nothing to load while
	// the tab is gated off.
	const assistantChat = assistant.tabEnabled
		? await listChat(db, locals.user!.id, { storyId: story.id })
		: [];
	const assistantChatSummarised =
		assistant.tabEnabled && (await hasChatSummary(db, locals.user!.id, { storyId: story.id }));

	return {
		trashedScenes,
		story,
		universe,
		reading: await readingPageRef(db, story.id),
		preferences,
		assistantChat,
		assistantChatSummarised,
		storySiblings,
		chapters: chapterList,
		scenes: sceneList,
		selectedScene,
		sceneNotes,
		storyNotes,
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
	...sceneManageActions((slug) => `/stories/${slug}`),
	// The per-story mute on the Assistant tab. A story can only subtract: muting
	// writes enabled:false, un-muting clears the override so the story follows
	// the account again. Neither can light the Assistant up when the account is
	// off (the master is the kill switch). The default enhance reloads the page,
	// so the gate re-renders.
	// "New note on this scene" from the Notes panel: makes the note and opens
	// it in Notes mode, which is where notes are managed.
	newSceneNote: async ({ request, params, locals }) => {
		const { story, universe } = await ownedStory(params.id, locals.user!.id);
		const sceneId = formText(await request.formData(), 'sceneId');
		if (!isUuid(sceneId)) {
			return fail(400, { scope: 'scene-note', message: 'Could not add a note to that scene.' });
		}
		const [scene] = await db
			.select({ id: scenes.id })
			.from(scenes)
			.where(and(eq(scenes.id, sceneId), eq(scenes.storyId, story.id)));
		if (!scene) {
			return fail(400, { scope: 'scene-note', message: 'Could not add a note to that scene.' });
		}
		const noteId = await createSceneNote(db, locals.user!.id, universe.id, story.id, sceneId);
		redirect(303, `/stories/${story.slug}/notes?note=${noteId}`);
	},
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
