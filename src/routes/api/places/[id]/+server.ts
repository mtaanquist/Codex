import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { savePlace } from '$lib/server/places';
import { queueUniverseMentions } from '$lib/server/jobs';
import { cleanDetails } from '$lib/entity-snapshot';

// Debounced autosave target for the place editor.
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	const payload = (await request.json()) as {
		name?: unknown;
		summaryMd?: unknown;
		bodyMd?: unknown;
		details?: unknown;
		categoryId?: unknown;
		storyId?: unknown;
		storyNotesMd?: unknown;
	};
	if (typeof payload.name !== 'string' || typeof payload.bodyMd !== 'string') {
		error(400, 'name and bodyMd must be strings');
	}

	const result = await savePlace(db, params.id, locals.user!.id, {
		name: payload.name,
		summaryMd: typeof payload.summaryMd === 'string' ? payload.summaryMd : null,
		bodyMd: payload.bodyMd,
		details: payload.details !== undefined ? cleanDetails(payload.details) : undefined,
		categoryId:
			payload.categoryId === null
				? null
				: typeof payload.categoryId === 'string'
					? payload.categoryId
					: undefined,
		storyId: typeof payload.storyId === 'string' ? payload.storyId : undefined,
		storyNotesMd: typeof payload.storyNotesMd === 'string' ? payload.storyNotesMd : undefined
	});
	if (!result.ok) {
		error(result.reason.includes('not found') ? 404 : 400, result.reason);
	}
	if (result.mentionsAffected) {
		await queueUniverseMentions(result.universeId);
	}
	return json({ savedAt: new Date().toISOString() });
};
