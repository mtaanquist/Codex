import { error, json } from '@sveltejs/kit';
import { throwActionError } from '$lib/server/action-result';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { saveNote } from '$lib/server/notes';
import { rateLimitWrites } from '$lib/server/write-guard';
import { checkProseLength, readJson } from '$lib/server/validation';

// Debounced autosave target for the note editor.
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	rateLimitWrites(locals.user!.id);
	const payload = await readJson<{ title?: unknown; bodyMd?: unknown }>(request);
	if (typeof payload.bodyMd !== 'string') {
		error(400, 'bodyMd must be a string');
	}
	checkProseLength(payload.bodyMd);
	const result = await saveNote(db, params.id, locals.user!.id, {
		title: typeof payload.title === 'string' ? payload.title : null,
		bodyMd: payload.bodyMd
	});
	if (!result.ok) throwActionError(result);
	return json({ savedAt: new Date().toISOString() });
};
