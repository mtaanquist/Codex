import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '#lib/server/db';
import { ownedScene } from '#lib/server/scene-access';
import { queueSceneMentions } from '#lib/server/jobs';
import { rateLimitWrites } from '#lib/server/write-guard';
import { checkProseLength, readJson } from '#lib/server/validation';
import { saveSceneBody } from '#lib/server/scene-save';
import { setSceneStatus } from '#lib/server/scene-status';
import { isSceneStatus } from '#lib/scene-status';

// Debounced autosave target for the scene editor.
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	rateLimitWrites(locals.user!.id);
	const row = await ownedScene(db, locals.user!.id, params.id);
	if (!row) error(404, 'Scene not found');

	const payload = await readJson<{
		title?: unknown;
		bodyMd?: unknown;
		markers?: unknown;
		baseHashes?: unknown;
		overwrite?: unknown;
	}>(request);
	if (typeof payload.bodyMd !== 'string') {
		error(400, 'bodyMd must be a string');
	}
	checkProseLength(payload.bodyMd);
	// The editor maps marker anchors through edits; they ride the autosave.
	// A review save omits markers entirely (the review centre does not load
	// them): when the field is absent, the stored anchors are mapped through
	// the text change rather than wiped with an empty set.
	const anchors =
		payload.markers === undefined
			? null
			: Array.isArray(payload.markers)
				? payload.markers.filter(
						(marker): marker is { id: string; anchorStart: number; anchorEnd: number } =>
							typeof marker === 'object' &&
							marker !== null &&
							typeof (marker as Record<string, unknown>).id === 'string' &&
							typeof (marker as Record<string, unknown>).anchorStart === 'number' &&
							typeof (marker as Record<string, unknown>).anchorEnd === 'number'
					)
				: [];
	// A tab opened before the conflict check shipped sends no fingerprints;
	// its saves still go through until it reloads.
	let baseHashes: string[] | null = null;
	if (payload.baseHashes !== undefined) {
		if (
			!Array.isArray(payload.baseHashes) ||
			payload.baseHashes.length === 0 ||
			payload.baseHashes.length > 4 ||
			!payload.baseHashes.every((hash) => typeof hash === 'string' && hash.length <= 32)
		) {
			error(400, 'baseHashes must be a short list of strings');
		}
		baseHashes = payload.baseHashes as string[];
	}
	const title =
		typeof payload.title === 'string' && payload.title.trim() !== '' ? payload.title.trim() : null;

	const result = await saveSceneBody(db, row.id, {
		title,
		bodyMd: payload.bodyMd,
		anchors,
		baseHashes,
		overwrite: payload.overwrite === true
	});
	if (!result.ok && 'missing' in result) error(404, 'Scene not found');
	if (!result.ok) {
		// The scene changed somewhere else since this editor last saw it; the
		// editor offers to load that version or keep its own.
		return Response.json({ conflict: true, ...result.conflict }, { status: 409 });
	}
	if (result.bodyChanged) await queueSceneMentions(row.id);

	return Response.json({ savedAt: new Date().toISOString(), wordCount: result.wordCount });
};

// Status changes come from the scene board, separate from the autosave: no
// revision, no mention rebuild, just the ladder position.
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	rateLimitWrites(locals.user!.id);
	const payload = await readJson<{ status?: unknown }>(request);
	if (!isSceneStatus(payload.status)) {
		error(400, 'status must be one of outline, draft, revised, final');
	}
	const changed = await setSceneStatus(db, locals.user!.id, params.id, payload.status);
	if (!changed) error(404, 'Scene not found');
	return Response.json({ ok: true });
};
