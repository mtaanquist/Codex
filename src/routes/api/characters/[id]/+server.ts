import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { saveCharacter } from '$lib/server/characters';

// Debounced autosave target for the character editor.
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	const payload = (await request.json()) as {
		name?: unknown;
		aliases?: unknown;
		summaryMd?: unknown;
		bodyMd?: unknown;
		storyId?: unknown;
		storyNotesMd?: unknown;
	};
	if (typeof payload.name !== 'string' || typeof payload.bodyMd !== 'string') {
		error(400, 'name and bodyMd must be strings');
	}
	const aliases = Array.isArray(payload.aliases)
		? payload.aliases.filter((alias): alias is string => typeof alias === 'string')
		: [];

	const result = await saveCharacter(db, params.id, locals.user!.id, {
		name: payload.name,
		aliases,
		summaryMd: typeof payload.summaryMd === 'string' ? payload.summaryMd : null,
		bodyMd: payload.bodyMd,
		storyId: typeof payload.storyId === 'string' ? payload.storyId : undefined,
		storyNotesMd: typeof payload.storyNotesMd === 'string' ? payload.storyNotesMd : undefined
	});
	if (!result.ok) {
		error(result.reason.includes('not found') ? 404 : 400, result.reason);
	}
	return json({ savedAt: new Date().toISOString() });
};
