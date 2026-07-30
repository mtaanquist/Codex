import { error, json } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { throwActionError } from '$lib/server/action-result';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { scenes, stories } from '$lib/server/db/schema';
import { createSceneNote, createStoryNote, saveNote } from '$lib/server/notes';
import { rateLimitWrites } from '$lib/server/write-guard';
import { checkProseLength, readJson } from '$lib/server/validation';
import { isUuid } from '$lib/slug';

// The quick-note jot: creates a story note (attached to a scene when one is
// named) and saves its text in one request, so the writer never has to leave
// the editor for the Notes page.
export const POST: RequestHandler = async ({ request, locals }) => {
	rateLimitWrites(locals.user!.id);
	const payload = await readJson<{
		storyId?: unknown;
		sceneId?: unknown;
		title?: unknown;
		bodyMd?: unknown;
	}>(request);
	const storyId = typeof payload.storyId === 'string' ? payload.storyId : '';
	if (!isUuid(storyId)) error(400, 'storyId must name a story');
	if (typeof payload.bodyMd !== 'string' || payload.bodyMd.trim() === '') {
		error(400, 'bodyMd must be a non-empty string');
	}
	checkProseLength(payload.bodyMd);
	const [story] = await db
		.select({ id: stories.id, universeId: stories.universeId, slug: stories.slug })
		.from(stories)
		.where(and(eq(stories.id, storyId), eq(stories.ownerId, locals.user!.id)));
	if (!story) error(404, 'Story not found');
	let sceneId: string | null = null;
	if (payload.sceneId !== undefined && payload.sceneId !== null) {
		if (typeof payload.sceneId !== 'string' || !isUuid(payload.sceneId)) {
			error(400, 'sceneId must name a scene');
		}
		const [scene] = await db
			.select({ id: scenes.id })
			.from(scenes)
			.where(and(eq(scenes.id, payload.sceneId), eq(scenes.storyId, story.id)));
		if (!scene) error(400, 'That scene is not in this story');
		sceneId = scene.id;
	}
	const noteId = sceneId
		? await createSceneNote(db, locals.user!.id, story.universeId, story.id, sceneId)
		: await createStoryNote(db, locals.user!.id, story.universeId, story.id);
	const result = await saveNote(db, noteId, locals.user!.id, {
		title: typeof payload.title === 'string' ? payload.title : null,
		bodyMd: payload.bodyMd
	});
	if (!result.ok) throwActionError(result);
	return json({ id: noteId, href: `/stories/${story.slug}/notes?note=${noteId}` });
};
