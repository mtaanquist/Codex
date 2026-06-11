import { error, type RequestHandler } from '@sveltejs/kit';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { scenes } from '$lib/server/db/schema';
import {
	assistantSseResponse,
	readAssistantPayload,
	requireAssistantStory
} from '$lib/server/llm/assistant-route';
import { assembleRecapContext } from '$lib/server/llm/context/assemble';
import { buildRecapMessage } from '$lib/server/llm/prompts/recap';
import type { ChatMessage } from '$lib/server/llm/providers/types';

// Recap ("catch me up"): the server assembles the story so far - every scene up
// to and including the open one - and streams a recap back as Server-Sent
// Events, the same transport as chat. It summarises existing prose and runs no
// tools. The key and endpoint never leave the server.

export const POST: RequestHandler = async ({ request, locals }) => {
	const { userId, payload } = await readAssistantPayload<{
		storyId?: unknown;
		sceneId?: unknown;
	}>(request, locals);
	const sceneId = typeof payload.sceneId === 'string' ? payload.sceneId : undefined;
	const story = await requireAssistantStory(userId, payload.storyId);

	const context = await assembleRecapContext(db, { userId, storyId: story.id, sceneId });
	if (!context) error(404, 'No story to recap.');

	// The scene the recap runs through, for the instruction; owner already checked.
	let throughTitle: string | null = null;
	if (sceneId) {
		const [scene] = await db
			.select({ title: scenes.title })
			.from(scenes)
			.where(and(eq(scenes.id, sceneId), eq(scenes.storyId, story.id), isNull(scenes.deletedAt)));
		throughTitle = scene?.title ?? null;
	}

	const messages: ChatMessage[] = [
		{ role: 'system', content: context },
		{ role: 'user', content: buildRecapMessage(throughTitle) }
	];

	// The recap joins the stored conversation as an assistant turn once its
	// stream ends cleanly.
	return assistantSseResponse({
		request,
		userId,
		storyId: story.id,
		role: 'chat',
		enableTools: false,
		messages,
		errorMessage: 'The Assistant could not put together a recap.'
	});
};
