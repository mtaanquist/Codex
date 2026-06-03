import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { saveLoreEntry } from '$lib/server/lore';
import { queueUniverseMentions } from '$lib/server/jobs';

// Debounced autosave target for the lore editor.
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	const payload = (await request.json()) as {
		name?: unknown;
		keywords?: unknown;
		summaryMd?: unknown;
		bodyMd?: unknown;
		categoryId?: unknown;
		storyId?: unknown;
		storyNotesMd?: unknown;
	};
	if (typeof payload.name !== 'string' || typeof payload.bodyMd !== 'string') {
		error(400, 'name and bodyMd must be strings');
	}
	const keywords = Array.isArray(payload.keywords)
		? payload.keywords.filter((keyword): keyword is string => typeof keyword === 'string')
		: [];

	const result = await saveLoreEntry(db, params.id, locals.user!.id, {
		name: payload.name,
		keywords,
		summaryMd: typeof payload.summaryMd === 'string' ? payload.summaryMd : null,
		bodyMd: payload.bodyMd,
		categoryId: typeof payload.categoryId === 'string' ? payload.categoryId : undefined,
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
