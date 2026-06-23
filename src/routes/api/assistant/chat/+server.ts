import { error, json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { ownedStory } from '$lib/server/story-access';
import { ownedUniverse } from '$lib/server/universe-access';
import {
	assistantSseResponse,
	readAssistantPayload,
	requireAssistantStory,
	requireAssistantUniverse
} from '$lib/server/llm/assistant-route';
import {
	assembleContext,
	buildSystemMessage,
	type AssembleOptions
} from '$lib/server/llm/context/assemble';
import { appendChat, clearChat, type ChatScope } from '$lib/server/llm/chat-history';
import {
	foldReference,
	readReference,
	type ChatReference
} from '$lib/server/llm/prompts/reference';
import type { ChatMessage } from '$lib/server/llm/providers/types';

// The chat surface: the browser POSTs its transcript and either the open story
// (and scene) or the universe in view, the server assembles the in-scope world,
// runs the gateway, and streams tokens back as Server-Sent Events. The key and
// endpoint never leave the server. The conversation persists per scope and
// user: the newest user turn is stored when the request is accepted, the reply
// when its stream completes.
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
		universeId?: unknown;
		sceneId?: unknown;
		messages?: unknown;
	}>(request, locals);
	const sceneId = typeof payload.sceneId === 'string' ? payload.sceneId : undefined;
	const turns = readTurns(payload.messages);

	// The scope: a story focus (Write/Review/story-Plan) or the whole universe
	// (universe-Plan). A storyId names the focus path; otherwise universeId.
	let scope: ChatScope;
	let assembleOptions: AssembleOptions;
	if (typeof payload.storyId === 'string' && payload.storyId) {
		const story = await requireAssistantStory(userId, payload.storyId);
		scope = { storyId: story.id };
		assembleOptions = { userId, storyId: story.id, sceneId };
	} else {
		const universe = await requireAssistantUniverse(userId, payload.universeId);
		scope = { universeId: universe.id };
		assembleOptions = { userId, universeId: universe.id };
	}

	// The newest user turn joins the stored transcript; the earlier turns are
	// already there from their own requests.
	const newest = turns[turns.length - 1];
	if (newest.role === 'user') {
		await appendChat(db, userId, scope, {
			role: 'user',
			content: newest.content,
			meta: newest.reference ? { reference: newest.reference } : null
		});
	}

	// The assembled world rides as a system message after the gateway's persona
	// message; null when the scope is empty or not owned (already checked).
	const context = await assembleContext(db, assembleOptions);
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
		scope,
		role: 'chat',
		enableTools: true,
		messages,
		errorMessage: 'The Assistant could not complete that request.'
	});
};

// Clear conversation: drops the stored transcript for this scope. Deletes only,
// so it needs ownership but no Assistant gate.
export const DELETE: RequestHandler = async ({ request, locals }) => {
	const { userId, payload } = await readAssistantPayload<{
		storyId?: unknown;
		universeId?: unknown;
	}>(request, locals);
	if (typeof payload.storyId === 'string' && payload.storyId) {
		const { story } = await ownedStory(payload.storyId, userId);
		await clearChat(db, userId, { storyId: story.id });
	} else if (typeof payload.universeId === 'string' && payload.universeId) {
		const universe = await ownedUniverse(payload.universeId, userId);
		await clearChat(db, userId, { universeId: universe.id });
	} else {
		error(400, 'storyId or universeId is required.');
	}
	return json({ ok: true });
};
