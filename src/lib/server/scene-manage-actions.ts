import { fail, redirect, type Actions } from '@sveltejs/kit';
import { db } from './db';
import { ownedStory } from './story-access';
import { isUuid } from '$lib/slug';
import { queueSceneMentions } from './jobs';
import {
	createChapter,
	createScene,
	deleteChapter,
	destroyScene,
	moveChapter,
	renameChapter,
	restoreScene,
	trashScene
} from './scene-lifecycle';

// The sidebar outline's chapter and scene management, as form actions shared by
// the Write and Review routes. StoryOutline and StoryRowMenu post to relative
// actions (?/deleteScene and the like), so each route that renders the outline
// spreads these in; `base` decides where a finished action lands - the editor on
// Write, the review page on Review. The logic itself lives in scene-lifecycle;
// these wrappers only validate input and redirect.
export function sceneManageActions(base: (slug: string) => string): Actions {
	// Where a sidebar action returns after the reload: the open scene when the
	// form carried one, the route's base otherwise.
	const sceneReturn = (slug: string, data: FormData) => {
		const open = String(data.get('openSceneId') ?? '');
		return open ? `${base(slug)}?scene=${open}` : base(slug);
	};
	return {
		createChapter: async ({ params, locals }) => {
			const { story } = await ownedStory(params.id!, locals.user!.id);
			await createChapter(db, locals.user!.id, story.id);
			return { created: 'chapter' };
		},
		createScene: async ({ request, params, locals }) => {
			const { story } = await ownedStory(params.id!, locals.user!.id);
			const data = await request.formData();
			const chapterId = String(data.get('chapterId') ?? '') || null;
			// Guard the uuid cast: a tampered id would throw in Postgres and 500.
			if (chapterId && !isUuid(chapterId)) {
				return fail(400, { message: 'That chapter does not exist.' });
			}
			const sceneId = await createScene(db, locals.user!.id, story.id, chapterId);
			if (!sceneId) return fail(400, { message: 'That chapter does not exist.' });
			redirect(303, `${base(story.slug)}?scene=${sceneId}`);
		},
		renameChapter: async ({ request, params, locals }) => {
			const { story } = await ownedStory(params.id!, locals.user!.id);
			const data = await request.formData();
			const chapterId = String(data.get('chapterId') ?? '');
			if (!isUuid(chapterId)) return fail(404, { message: 'That chapter does not exist.' });
			const ok = await renameChapter(
				db,
				locals.user!.id,
				chapterId,
				String(data.get('title') ?? '')
			);
			if (!ok) return fail(404, { message: 'That chapter does not exist.' });
			redirect(303, sceneReturn(story.slug, data));
		},
		moveChapter: async ({ request, params, locals }) => {
			const { story } = await ownedStory(params.id!, locals.user!.id);
			const data = await request.formData();
			const chapterId = String(data.get('chapterId') ?? '');
			if (!isUuid(chapterId)) return fail(404, { message: 'That chapter does not exist.' });
			const direction = data.get('direction') === 'up' ? ('up' as const) : ('down' as const);
			const ok = await moveChapter(db, locals.user!.id, chapterId, direction);
			if (!ok) return fail(404, { message: 'That chapter does not exist.' });
			redirect(303, sceneReturn(story.slug, data));
		},
		deleteChapter: async ({ request, params, locals }) => {
			const { story } = await ownedStory(params.id!, locals.user!.id);
			const data = await request.formData();
			const chapterId = String(data.get('chapterId') ?? '');
			if (!isUuid(chapterId)) return fail(404, { message: 'That chapter does not exist.' });
			const ok = await deleteChapter(db, locals.user!.id, chapterId);
			if (!ok) return fail(404, { message: 'That chapter does not exist.' });
			redirect(303, sceneReturn(story.slug, data));
		},
		deleteScene: async ({ request, params, locals }) => {
			const { story } = await ownedStory(params.id!, locals.user!.id);
			const data = await request.formData();
			const sceneId = String(data.get('sceneId') ?? '');
			if (!isUuid(sceneId)) return fail(404, { message: 'That scene does not exist.' });
			const ok = await trashScene(db, locals.user!.id, sceneId);
			if (!ok) return fail(404, { message: 'That scene does not exist.' });
			// Deleting the open scene closes it; deleting another keeps it open.
			const open = String(data.get('openSceneId') ?? '');
			redirect(
				303,
				open && open !== sceneId ? `${base(story.slug)}?scene=${open}` : base(story.slug)
			);
		},
		restoreScene: async ({ request, params, locals }) => {
			const { story } = await ownedStory(params.id!, locals.user!.id);
			const data = await request.formData();
			const sceneId = String(data.get('sceneId') ?? '');
			if (!isUuid(sceneId)) return fail(404, { message: 'That scene is not in the trash.' });
			const ok = await restoreScene(db, locals.user!.id, sceneId);
			if (!ok) return fail(404, { message: 'That scene is not in the trash.' });
			await queueSceneMentions(sceneId);
			redirect(303, `${base(story.slug)}?scene=${sceneId}`);
		},
		destroyScene: async ({ request, params, locals }) => {
			const { story } = await ownedStory(params.id!, locals.user!.id);
			const data = await request.formData();
			const sceneId = String(data.get('sceneId') ?? '');
			if (!isUuid(sceneId)) return fail(404, { message: 'That scene is not in the trash.' });
			const ok = await destroyScene(db, locals.user!.id, sceneId);
			if (!ok) return fail(404, { message: 'That scene is not in the trash.' });
			redirect(303, sceneReturn(story.slug, data));
		}
	};
}
