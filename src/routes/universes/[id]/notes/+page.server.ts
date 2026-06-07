import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { ownedUniverse } from '$lib/server/universe-access';
import {
	createUniverseNote,
	deleteNote,
	getNote,
	listUniverseNotes,
	setNotePinned
} from '$lib/server/notes';
import { getRevision, listRevisions, type RevisionRow } from '$lib/server/revisions';

export const load: PageServerLoad = async ({ params, locals, url }) => {
	const universe = await ownedUniverse(params.id, locals.user!.id);
	const universeNotes = await listUniverseNotes(db, universe.id, locals.user!.id);

	const noteId = url.searchParams.get('note');
	let selected = null;
	if (noteId) {
		const note = await getNote(db, noteId, locals.user!.id);
		// Universe notes only: a story note belongs to its story's view.
		if (note && note.universeId === universe.id && note.storyId === null) selected = note;
	}

	let revisionRows: RevisionRow[] = [];
	let revisionPreview = null;
	if (selected) {
		revisionRows = await listRevisions(db, 'note', selected.id);
		const revisionId = url.searchParams.get('revision');
		if (revisionId) {
			revisionPreview = (await getRevision(db, revisionId, 'note', selected.id)) ?? null;
		}
	}

	return { universe, universeNotes, selected, revisionRows, revisionPreview };
};

export const actions: Actions = {
	createNote: async ({ params, locals }) => {
		const universe = await ownedUniverse(params.id, locals.user!.id);
		const id = await createUniverseNote(db, locals.user!.id, universe.id);
		redirect(303, `/universes/${universe.slug}/notes?note=${id}`);
	},
	setPinned: async ({ request, params, locals }) => {
		const universe = await ownedUniverse(params.id, locals.user!.id);
		const data = await request.formData();
		const noteId = String(data.get('noteId') ?? '');
		const pinned = data.get('pinned') === 'true';
		if (!noteId || !(await setNotePinned(db, noteId, locals.user!.id, pinned))) {
			return fail(400, { scope: 'note', message: 'Could not update that note.' });
		}
		redirect(303, `/universes/${universe.slug}/notes?note=${noteId}`);
	},
	deleteNote: async ({ request, params, locals }) => {
		const universe = await ownedUniverse(params.id, locals.user!.id);
		const noteId = String((await request.formData()).get('noteId') ?? '');
		if (!noteId || !(await deleteNote(db, noteId, locals.user!.id))) {
			return fail(400, { scope: 'note', message: 'Could not delete that note.' });
		}
		redirect(303, `/universes/${universe.slug}/notes`);
	}
};
