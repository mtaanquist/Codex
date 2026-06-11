import { error, json } from '@sveltejs/kit';
import { throwActionError } from '$lib/server/action-result';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { rateLimitWrites } from '$lib/server/write-guard';
import { clearMentionPin, setMentionPin } from '$lib/server/mention-pins';
import { stories } from '$lib/server/db/schema';
import { queueUniverseMentions } from '$lib/server/jobs';
import { eq } from 'drizzle-orm';
import { readJson } from '$lib/server/validation';

const TYPES = ['character', 'place', 'lore_entry'] as const;

// Re-attribution: a changed pin moves existing index rows, so the
// universe's scenes rebuild. Best-effort; the reconcile sweep self-heals.
async function requeue(storyId: string) {
	const [story] = await db
		.select({ universeId: stories.universeId })
		.from(stories)
		.where(eq(stories.id, storyId));
	if (story) await queueUniverseMentions(story.universeId);
}

// Pins which entity an ambiguous name means in this story.
export const POST: RequestHandler = async ({ params, request, locals }) => {
	rateLimitWrites(locals.user!.id);
	const payload = await readJson<{
		name?: unknown;
		targetType?: unknown;
		targetId?: unknown;
	}>(request);
	if (
		typeof payload.name !== 'string' ||
		!TYPES.includes(payload.targetType as (typeof TYPES)[number]) ||
		typeof payload.targetId !== 'string'
	) {
		error(400, 'name, targetType, and targetId are required');
	}
	const result = await setMentionPin(
		db,
		locals.user!.id,
		params.id,
		payload.name,
		payload.targetType as (typeof TYPES)[number],
		payload.targetId
	);
	if (!result.ok) {
		throwActionError(result);
	}
	await requeue(params.id);
	return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ params, request, locals }) => {
	rateLimitWrites(locals.user!.id);
	const payload = await readJson<{ name?: unknown }>(request);
	if (typeof payload.name !== 'string') error(400, 'name is required');
	const removed = await clearMentionPin(db, locals.user!.id, params.id, payload.name);
	if (!removed) error(404, 'pin not found');
	await requeue(params.id);
	return json({ ok: true });
};
