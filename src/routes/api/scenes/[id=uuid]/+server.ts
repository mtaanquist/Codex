import { error, json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { scenes } from '$lib/server/db/schema';
import { ownedScene } from '$lib/server/scene-access';
import { queueSceneMentions } from '$lib/server/jobs';
import { updateMarkerAnchors } from '$lib/server/markers';
import { rateLimitWrites } from '$lib/server/write-guard';
import { checkProseLength, readJson } from '$lib/server/validation';
import { recordRevision } from '$lib/server/revisions';
import { setSceneStatus } from '$lib/server/scene-status';
import { isSceneStatus } from '$lib/scene-status';
import { wordCount } from '$lib/word-count';

// Debounced autosave target for the scene editor.
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	rateLimitWrites(locals.user!.id);
	const row = await ownedScene(db, locals.user!.id, params.id);
	if (!row) error(404, 'Scene not found');

	const payload = await readJson<{
		title?: unknown;
		bodyMd?: unknown;
		markers?: unknown;
	}>(request);
	if (typeof payload.bodyMd !== 'string') {
		error(400, 'bodyMd must be a string');
	}
	checkProseLength(payload.bodyMd);
	// The editor maps marker anchors through edits; they ride the autosave.
	// A review save omits markers entirely (the review centre does not load
	// them): when the field is absent, leave the stored anchors untouched
	// rather than wiping them with an empty set.
	const touchMarkers = payload.markers !== undefined;
	const anchors = Array.isArray(payload.markers)
		? payload.markers.filter(
				(marker): marker is { id: string; anchorStart: number; anchorEnd: number } =>
					typeof marker === 'object' &&
					marker !== null &&
					typeof (marker as Record<string, unknown>).id === 'string' &&
					typeof (marker as Record<string, unknown>).anchorStart === 'number' &&
					typeof (marker as Record<string, unknown>).anchorEnd === 'number'
			)
		: [];
	const title =
		typeof payload.title === 'string' && payload.title.trim() !== '' ? payload.title.trim() : null;

	const count = wordCount(payload.bodyMd);
	await db
		.update(scenes)
		.set({ title, bodyMd: payload.bodyMd, wordCount: count })
		.where(eq(scenes.id, row.id));
	await recordRevision(db, 'scene', row.id, payload.bodyMd);
	if (touchMarkers) await updateMarkerAnchors(db, row.id, anchors, payload.bodyMd.length);
	await queueSceneMentions(row.id);

	return json({ savedAt: new Date().toISOString(), wordCount: count });
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
	return json({ ok: true });
};
