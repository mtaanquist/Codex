import { error, fail, redirect } from '@sveltejs/kit';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { chapters, scenes, stories, universes } from '$lib/server/db/schema';

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

	const selectedId = url.searchParams.get('scene');
	let selectedScene = null;
	if (selectedId) {
		const [row] = await db
			.select()
			.from(scenes)
			.where(and(eq(scenes.id, selectedId), eq(scenes.storyId, story.id)));
		selectedScene = row ?? null;
	}

	return {
		story,
		universe,
		user: locals.user!,
		chapters: chapterList,
		scenes: sceneList,
		selectedScene
	};
};

export const actions: Actions = {
	createChapter: async ({ params, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		const [{ next }] = await db
			.select({ next: sql<number>`coalesce(max(${chapters.position}), 0) + 1` })
			.from(chapters)
			.where(eq(chapters.storyId, story.id));
		await db.insert(chapters).values({ storyId: story.id, position: next });
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
		const [{ nextGlobal }] = await db
			.select({ nextGlobal: sql<number>`coalesce(max(${scenes.globalPosition}), 0) + 1` })
			.from(scenes)
			.where(eq(scenes.storyId, story.id));
		let positionInChapter: number | null = null;
		if (chapterId) {
			const [{ nextInChapter }] = await db
				.select({ nextInChapter: sql<number>`coalesce(max(${scenes.positionInChapter}), 0) + 1` })
				.from(scenes)
				.where(eq(scenes.chapterId, chapterId));
			positionInChapter = nextInChapter;
		}
		const [scene] = await db
			.insert(scenes)
			.values({ storyId: story.id, chapterId, positionInChapter, globalPosition: nextGlobal })
			.returning({ id: scenes.id });
		redirect(303, `/stories/${story.id}?scene=${scene.id}`);
	}
};
