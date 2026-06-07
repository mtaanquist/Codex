import { error, json } from '@sveltejs/kit';
import { throwActionError } from '$lib/server/action-result';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { saveNote } from '$lib/server/notes';

// Debounced autosave target for the note editor.
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	const payload = (await request.json()) as { title?: unknown; bodyMd?: unknown };
	if (typeof payload.bodyMd !== 'string') {
		error(400, 'bodyMd must be a string');
	}
	const result = await saveNote(db, params.id, locals.user!.id, {
		title: typeof payload.title === 'string' ? payload.title : null,
		bodyMd: payload.bodyMd
	});
	if (!result.ok) throwActionError(result);
	return json({ savedAt: new Date().toISOString() });
};
