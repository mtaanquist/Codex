import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { ownedStory } from '$lib/server/story-access';
import {
	createStoryNote,
	deleteNote,
	getNote,
	listStoryNotes,
	listUniverseNotes,
	setNotePinned
} from '$lib/server/notes';
import { getRevision, listRevisions, type RevisionRow } from '$lib/server/revisions';
import { isUuid } from '$lib/slug';

export const load: PageServerLoad = async ({ params, locals, url }) => {
	const { story, universe } = await ownedStory(params.id, locals.user!.id);

	const [storyNotes, universeNotes] = await Promise.all([
		listStoryNotes(db, story.id, locals.user!.id),
		listUniverseNotes(db, universe.id, locals.user!.id)
	]);

	// Guard the uuid casts: a tampered query value would throw in Postgres
	// and 500 instead of being ignored.
	const noteId = url.searchParams.get('note');
	let selected = null;
	if (noteId && isUuid(noteId)) {
		const note = await getNote(db, noteId, locals.user!.id);
		// Only this story's notes open here; universe notes link to their own view.
		if (note && note.storyId === story.id) selected = note;
	}

	let revisionRows: RevisionRow[] = [];
	let revisionPreview = null;
	if (selected) {
		revisionRows = await listRevisions(db, 'note', selected.id);
		const revisionId = url.searchParams.get('revision');
		if (revisionId && isUuid(revisionId)) {
			revisionPreview = (await getRevision(db, revisionId, 'note', selected.id)) ?? null;
		}
	}

	return { story, universe, storyNotes, universeNotes, selected, revisionRows, revisionPreview };
};

export const actions: Actions = {
	createNote: async ({ params, locals }) => {
		const { story, universe } = await ownedStory(params.id, locals.user!.id);
		const id = await createStoryNote(db, locals.user!.id, universe.id, story.id);
		redirect(303, `/stories/${story.slug}/notes?note=${id}`);
	},
	setPinned: async ({ request, params, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		const data = await request.formData();
		const noteId = String(data.get('noteId') ?? '');
		const pinned = data.get('pinned') === 'true';
		if (!isUuid(noteId) || !(await setNotePinned(db, noteId, locals.user!.id, pinned))) {
			return fail(400, { scope: 'note', message: 'Could not update that note.' });
		}
		redirect(303, `/stories/${story.slug}/notes?note=${noteId}`);
	},
	deleteNote: async ({ request, params, locals }) => {
		const { story } = await ownedStory(params.id, locals.user!.id);
		const noteId = String((await request.formData()).get('noteId') ?? '');
		if (!isUuid(noteId) || !(await deleteNote(db, noteId, locals.user!.id))) {
			return fail(400, { scope: 'note', message: 'Could not delete that note.' });
		}
		redirect(303, `/stories/${story.slug}/notes`);
	}
};
