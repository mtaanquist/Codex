import { error, type RequestHandler } from '@sveltejs/kit';
import { db } from '#lib/server/db';
import {
	assistantSseResponse,
	readAssistantPayload,
	requireAssistantStory,
	requireAssistantUniverse,
	requireChat
} from '#lib/server/llm/assistant-route';
import { CHAT_MISSING, chatTitle, readChatSettings } from '#lib/assistant-chat';
import {
	assembleContext,
	buildSystemMessage,
	type AssembleOptions
} from '#lib/server/llm/context/assemble';
import { appendChat, setChatSettings, type ChatScope } from '#lib/server/llm/chat-history';
import { fitChatWithSummary } from '#lib/server/llm/chat-summary';
import { chatBudgetTokens, contextBudgetTokens } from '#lib/server/llm/context/budgets';
import { modelContextWindow, resolveLlmConfig, withRoleOverride } from '#lib/server/llm/config';
import {
	foldReference,
	readReference,
	type ChatReference
} from '#lib/server/llm/prompts/reference';
import type { ChatMessage } from '#lib/server/llm/providers/types';

// The chat surface: the browser POSTs its transcript and either the open story
// (and scene) or the universe in view, the server assembles the in-scope world,
// runs the gateway, and streams tokens back as Server-Sent Events. The key and
// endpoint never leave the server. Turns persist in the chat named by chatId,
// or a new chat when there is none (its id comes back as x-chat-id): the newest
// user turn is stored when the request is accepted, the reply when its stream
// completes.
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
		chatId?: unknown;
		newChatId?: unknown;
		messages?: unknown;
		settings?: unknown;
	}>(request, locals);
	const settings = readChatSettings(payload.settings);
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
	const chat = await requireChat(
		userId,
		scope,
		payload.chatId,
		chatTitle(newest.content),
		payload.newChatId
	);
	const chatId = chat.id;
	// An older client that sends no setting leaves the stored one alone.
	if (payload.settings !== undefined) await setChatSettings(db, userId, chatId, settings);
	if (newest.role === 'user') {
		const stored = await appendChat(db, userId, scope, chatId, {
			role: 'user',
			content: newest.content,
			meta: newest.reference ? { reference: newest.reference } : null
		});
		if (!stored) error(404, CHAT_MISSING);
	}

	// The assembled world rides as a system message after the gateway's persona
	// message; null when the scope is empty or not owned (already checked).
	// Both budgets scale with the Rubber duck model's context window.
	const resolved = await resolveLlmConfig(
		db,
		userId,
		'storyId' in scope ? scope.storyId : undefined
	);
	const contextWindow = modelContextWindow(
		withRoleOverride(resolved.config, 'chat', settings),
		'chat'
	);
	const context = await assembleContext(db, {
		...assembleOptions,
		budgetTokens: contextBudgetTokens(contextWindow)
	});
	// Folding a reference grows a turn, so the transcript is fitted to its budget
	// after the fold. Turns that fall out are summarised rather than dropped.
	// Request shaping only: the stored transcript and the panel's own scrollback
	// keep every turn.
	const fitted = await fitChatWithSummary(db, {
		userId,
		scope,
		chatId,
		turns: turns.map((turn) => ({
			role: turn.role,
			content: turn.reference ? foldReference(turn.content, turn.reference) : turn.content
		})),
		budgetTokens: chatBudgetTokens(contextWindow),
		signal: request.signal
	});
	const messages: ChatMessage[] = context
		? [buildSystemMessage(context, { tools: true }), ...fitted.messages]
		: fitted.messages;

	return assistantSseResponse({
		request,
		userId,
		scope,
		chat,
		role: 'chat',
		override: settings,
		enableTools: true,
		messages,
		summarised: fitted.summarised,
		errorMessage: 'The Assistant could not complete that request.'
	});
};
