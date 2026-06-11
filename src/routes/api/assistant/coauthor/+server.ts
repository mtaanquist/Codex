import { error, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import {
	readAssistantPayload,
	requireAssistantStory,
	throwAssistantError
} from '$lib/server/llm/assistant-route';
import { assembleContext, buildSystemMessage } from '$lib/server/llm/context/assemble';
import { buildCoauthorMessage, readCoauthorReference } from '$lib/server/llm/prompts/coauthor';
import { complete } from '$lib/server/llm/gateway';
import type { ChatMessage } from '$lib/server/llm/providers/types';

// Co-author: the writer gives a brief and the Assistant drafts a passage,
// grounded in the assembled world and the current scene. The result is returned
// for the writer to insert, edit, or reject in the panel - never written to the
// prose here. Buffered and tool-free, like continuation.

const MAX_COAUTHOR_TOKENS = 900;

export const POST: RequestHandler = async ({ request, locals }) => {
	const { userId, payload } = await readAssistantPayload<{
		storyId?: unknown;
		sceneId?: unknown;
		instruction?: unknown;
		reference?: unknown;
	}>(request, locals);
	const sceneId = typeof payload.sceneId === 'string' ? payload.sceneId : undefined;
	const instruction = typeof payload.instruction === 'string' ? payload.instruction.trim() : '';
	// Where the writer is in the prose; an unusable reference is just dropped.
	const reference = readCoauthorReference(payload.reference);
	if (!instruction) error(400, 'Tell the Assistant what to write.');
	if (instruction.length > 2000) error(400, 'That brief is too long.');
	const story = await requireAssistantStory(userId, payload.storyId);

	const context = await assembleContext(db, { userId, storyId: story.id, sceneId });
	const task: ChatMessage = { role: 'user', content: buildCoauthorMessage(instruction, reference) };
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
		throwAssistantError(err, 'The Assistant could not draft that passage.');
	}

	return new Response(JSON.stringify({ text: text.trim() }), {
		headers: { 'content-type': 'application/json' }
	});
};
