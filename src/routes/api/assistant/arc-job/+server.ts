import { error, type RequestHandler } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { db } from '#lib/server/db';
import { characters } from '#lib/server/db/schema';
import { inLiveUniverse } from '#lib/server/universe-scope';
import { readAssistantPayload, requireAssistantUniverse } from '#lib/server/llm/assistant-route';
import { queueAssistantArc } from '#lib/server/jobs';
import { isUuid } from '#lib/slug';

// Queues a rewrite of one character's arc across the universe's stories, a
// background job like the other Assistant passes. The writer is notified when
// it is written.

export const POST: RequestHandler = async ({ request, locals }) => {
	const { userId, payload } = await readAssistantPayload<{ characterId?: unknown }>(
		request,
		locals
	);
	const characterId = typeof payload.characterId === 'string' ? payload.characterId : '';
	if (!isUuid(characterId)) error(400, 'characterId is required.');
	const [character] = await db
		.select({ universeId: characters.universeId })
		.from(characters)
		.where(
			and(
				eq(characters.id, characterId),
				eq(characters.ownerId, userId),
				inLiveUniverse(characters.universeId)
			)
		);
	if (!character) error(404, 'Character not found');
	// The account gate; a character belongs to the universe, not one story.
	await requireAssistantUniverse(userId, character.universeId);

	const jobId = await queueAssistantArc({ userId, universeId: character.universeId, characterId });
	if (jobId === 'coalesced') {
		error(
			409,
			'The Assistant is already writing this arc. It carries on; this started nothing new.'
		);
	}
	if (!jobId) error(503, 'Could not start writing the arc. Try again in a moment.');

	return Response.json({ ok: true, jobId });
};
