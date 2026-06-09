import { error, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { ownedStory } from '$lib/server/story-access';
import { rateLimitAssistant } from '$lib/server/write-guard';
import { assistantLayout } from '$lib/server/llm/config';
import { assembleContext, buildSystemMessage } from '$lib/server/llm/context/assemble';
import { buildCoauthorMessage } from '$lib/server/llm/prompts/coauthor';
import { AssistantDisabledError, complete } from '$lib/server/llm/gateway';
import type { ChatMessage } from '$lib/server/llm/providers/types';

// Co-author: the writer gives a brief and the Assistant drafts a passage,
// grounded in the assembled world and the current scene. The result is returned
// for the writer to insert, edit, or reject in the panel - never written to the
// prose here. Buffered and tool-free, like continuation.

const MAX_COAUTHOR_TOKENS = 900;

export const POST: RequestHandler = async ({ request, locals }) => {
	const userId = locals.user!.id;
	rateLimitAssistant(userId);

	const payload = (await request.json().catch(() => null)) as {
		storyId?: unknown;
		sceneId?: unknown;
		instruction?: unknown;
	} | null;
	const storyId = payload && typeof payload.storyId === 'string' ? payload.storyId : '';
	const sceneId = payload && typeof payload.sceneId === 'string' ? payload.sceneId : undefined;
	const instruction =
		payload && typeof payload.instruction === 'string' ? payload.instruction.trim() : '';
	if (!storyId) error(400, 'storyId is required.');
	if (!instruction) error(400, 'Tell the Assistant what to write.');
	if (instruction.length > 2000) error(400, 'That brief is too long.');

	// 404s unless the user owns the story.
	const { story } = await ownedStory(storyId, userId);

	const layout = await assistantLayout(db, userId, story.id);
	if (!layout.surfacesEnabled) error(403, 'The Assistant is off for this story.');

	const context = await assembleContext(db, { userId, storyId: story.id, sceneId });
	const task: ChatMessage = { role: 'user', content: buildCoauthorMessage(instruction) };
	const messages: ChatMessage[] = context ? [buildSystemMessage(context), task] : [task];

	let text: string;
	try {
		text = await complete(db, {
			userId,
			storyId: story.id,
			role: 'coauthor',
			enableTools: false,
			messages,
			maxTokens: MAX_COAUTHOR_TOKENS,
			signal: request.signal
		});
	} catch (err) {
		if (err instanceof AssistantDisabledError) error(403, err.message);
		error(502, 'The Assistant could not draft that passage.');
	}

	return new Response(JSON.stringify({ text: text.trim() }), {
		headers: { 'content-type': 'application/json' }
	});
};
