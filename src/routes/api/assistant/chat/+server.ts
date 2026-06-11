import { error, json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { ownedStory } from '$lib/server/story-access';
import {
	assistantSseResponse,
	readAssistantPayload,
	requireAssistantStory
} from '$lib/server/llm/assistant-route';
import { assembleContext, buildSystemMessage } from '$lib/server/llm/context/assemble';
import { appendChat, clearChat } from '$lib/server/llm/chat-history';
import {
	foldReference,
	readReference,
	type ChatReference
} from '$lib/server/llm/prompts/reference';
import type { ChatMessage } from '$lib/server/llm/providers/types';

// The chat surface: the browser POSTs its transcript and the open scene, the
// server assembles the in-scope world, runs the gateway, and streams tokens
// back as Server-Sent Events. The key and endpoint never leave the server.
// The conversation persists per story and user: the newest user turn is
// stored when the request is accepted, the reply when its stream completes.
//
// Tools are offered (grounding reads, suggest_edit/leave_comment writes); the
// gateway withholds them when the endpoint cannot call them. A muted story
// disables this even though its tab stays visible to un-mute, so the gate is
// re-checked here.

type Turn = { role: 'user' | 'assistant'; content: string; reference: ChatReference | null };

// A single turn's text; far beyond any real message, in line with the other
// surfaces' input caps.
const MAX_TURN_CHARS = 20_000;

// Only the writer's own user/assistant turns are accepted; system and tool
// messages are the server's to add, never the client's. A user turn may carry
// a reference to a passage of the open story, kept as data for the transcript
// chip and folded into the content the model sees.
function readTurns(raw: unknown): Turn[] {
	if (!Array.isArray(raw)) error(400, 'messages must be an array.');
	const turns: Turn[] = [];
	for (const item of raw) {
		if (!item || typeof item !== 'object') continue;
		const role = (item as { role?: unknown }).role;
		const content = (item as { content?: unknown }).content;
		if ((role === 'user' || role === 'assistant') && typeof content === 'string') {
			if (content.length > MAX_TURN_CHARS) error(400, 'That message is too long.');
			const reference =
				role === 'user' ? readReference((item as { reference?: unknown }).reference) : null;
			turns.push({ role, content, reference });
		}
	}
	if (turns.length === 0) error(400, 'Send at least one message.');
	if (turns.length > 100) error(400, 'Conversation is too long.');
	return turns;
}

export const POST: RequestHandler = async ({ request, locals }) => {
	const { userId, payload } = await readAssistantPayload<{
		storyId?: unknown;
		sceneId?: unknown;
		messages?: unknown;
	}>(request, locals);
	const sceneId = typeof payload.sceneId === 'string' ? payload.sceneId : undefined;
	const turns = readTurns(payload.messages);
	const story = await requireAssistantStory(userId, payload.storyId);

	// The newest user turn joins the stored transcript; the earlier turns are
	// already there from their own requests.
	const newest = turns[turns.length - 1];
	if (newest.role === 'user') {
		await appendChat(db, userId, story.id, {
			role: 'user',
			content: newest.content,
			meta: newest.reference ? { reference: newest.reference } : null
		});
	}

	// The assembled world rides as a system message after the gateway's persona
	// message; null when the story is empty or not owned (already checked).
	const context = await assembleContext(db, { userId, storyId: story.id, sceneId });
	const modelTurns: ChatMessage[] = turns.map((turn) => ({
		role: turn.role,
		content: turn.reference ? foldReference(turn.content, turn.reference) : turn.content
	}));
	const messages: ChatMessage[] = context
		? [buildSystemMessage(context, { tools: true }), ...modelTurns]
		: modelTurns;

	return assistantSseResponse({
		request,
		userId,
		storyId: story.id,
		role: 'chat',
		enableTools: true,
		messages,
		errorMessage: 'The Assistant could not complete that request.'
	});
};

// Clear conversation: drops the stored transcript for this story. Deletes
// only, so it needs ownership but no Assistant gate.
export const DELETE: RequestHandler = async ({ request, locals }) => {
	const { userId, payload } = await readAssistantPayload<{ storyId?: unknown }>(request, locals);
	const storyId = typeof payload.storyId === 'string' ? payload.storyId : '';
	if (!storyId) error(400, 'storyId is required.');
	const { story } = await ownedStory(storyId, userId);
	await clearChat(db, userId, story.id);
	return json({ ok: true });
};
