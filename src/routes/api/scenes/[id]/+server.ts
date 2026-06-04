import { error, json } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { scenes, stories } from '$lib/server/db/schema';
import { queueSceneMentions } from '$lib/server/jobs';
import { updateMarkerAnchors } from '$lib/server/markers';
import { recordRevision } from '$lib/server/revisions';
import { wordCount } from '$lib/word-count';

// Debounced autosave target for the scene editor.
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	const [row] = await db
		.select({ id: scenes.id })
		.from(scenes)
		.innerJoin(stories, eq(scenes.storyId, stories.id))
		.where(and(eq(scenes.id, params.id), eq(stories.ownerId, locals.user!.id)));
	if (!row) error(404, 'Scene not found');

	const payload = (await request.json()) as {
		title?: unknown;
		bodyMd?: unknown;
		markers?: unknown;
	};
	if (typeof payload.bodyMd !== 'string') {
		error(400, 'bodyMd must be a string');
	}
	// The editor maps marker anchors through edits; they ride the autosave.
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
	await updateMarkerAnchors(db, row.id, anchors);
	await queueSceneMentions(row.id);

	return json({ savedAt: new Date().toISOString(), wordCount: count });
};
