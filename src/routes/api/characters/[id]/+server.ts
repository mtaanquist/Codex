import { error, json } from '@sveltejs/kit';
import { throwActionError } from '$lib/server/action-result';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { saveCharacter } from '$lib/server/characters';
import { queueUniverseMentions } from '$lib/server/jobs';
import { cleanDetails } from '$lib/entity-snapshot';

// Debounced autosave target for the character editor.
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	const payload = (await request.json()) as {
		name?: unknown;
		aliases?: unknown;
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
	const aliases = Array.isArray(payload.aliases)
		? payload.aliases.filter((alias): alias is string => typeof alias === 'string')
		: [];

	const result = await saveCharacter(db, params.id, locals.user!.id, {
		name: payload.name,
		aliases,
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
		throwActionError(result);
	}
	// Name or alias changes can add or remove mentions anywhere in the universe.
	if (result.mentionsAffected) {
		await queueUniverseMentions(result.universeId);
	}
	return json({ savedAt: new Date().toISOString() });
};
