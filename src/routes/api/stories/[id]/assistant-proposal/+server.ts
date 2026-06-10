import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { ownedStory } from '$lib/server/story-access';
import { setProposalConfirmed } from '$lib/server/llm/chat-history';

// Records a split proposal's outcome on its stored chat turn: the confirm
// sends what the split created, a revert sends null to reopen the card. The
// card state is cosmetic next to the split itself, but persisting it keeps
// the conversation honest across reloads.
export const POST: RequestHandler = async ({ params, request, locals }) => {
	const { story } = await ownedStory(params.id, locals.user!.id);
	const payload = (await request.json()) as {
		sceneId?: unknown;
		before?: unknown;
		confirmed?: { splitSceneId?: unknown; newSceneId?: unknown } | null;
	};
	if (typeof payload.sceneId !== 'string' || typeof payload.before !== 'string') {
		error(400, 'sceneId and before are required');
	}
	let confirmed: { splitSceneId: string; newSceneId: string } | null = null;
	if (payload.confirmed) {
		const { splitSceneId, newSceneId } = payload.confirmed;
		if (typeof splitSceneId !== 'string' || typeof newSceneId !== 'string') {
			error(400, 'confirmed needs splitSceneId and newSceneId');
		}
		confirmed = { splitSceneId, newSceneId };
	}
	const matched = await setProposalConfirmed(
		db,
		locals.user!.id,
		story.id,
		{ sceneId: payload.sceneId, before: payload.before },
		confirmed
	);
	return json({ ok: true, matched });
};
