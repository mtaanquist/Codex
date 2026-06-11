import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { createStoryEntity } from '$lib/server/create-entity';
import { queueUniverseMentions } from '$lib/server/jobs';
import { ownedStory } from '$lib/server/story-access';
import { readJson } from '$lib/server/validation';
import { rateLimitWrites } from '$lib/server/write-guard';

const TYPES = ['character', 'place', 'lore_entry'] as const;

// Create-from-selection in the scene editor: an entity by name alone. The
// universe rebuild picks the new name up across every scene.
export const POST: RequestHandler = async ({ params, request, locals }) => {
	rateLimitWrites(locals.user!.id);
	const { story, universe } = await ownedStory(params.id, locals.user!.id);
	const payload = await readJson<{
		type?: unknown;
		name?: unknown;
		categoryId?: unknown;
	}>(request);
	if (!TYPES.includes(payload.type as (typeof TYPES)[number]) || typeof payload.name !== 'string') {
		error(400, 'type and name are required');
	}
	const result = await createStoryEntity(
		db,
		{ universeId: universe.id, ownerId: locals.user!.id, storyId: story.id },
		payload.type as (typeof TYPES)[number],
		payload.name,
		typeof payload.categoryId === 'string' ? payload.categoryId : undefined
	);
	if (!result.ok) error(400, result.reason);
	await queueUniverseMentions(universe.id);
	return json({ ok: true, id: result.id });
};
